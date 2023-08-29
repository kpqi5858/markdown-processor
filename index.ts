import { parse } from 'yaml';
import fs from 'fs/promises';
import util from 'util';
import { program } from 'commander';
import {
  ContentType,
  FromFileName,
  FrontMatterOptionalStrippedProperties,
  FrontMatterYaml,
  PostNameRegex,
  PostsListType,
} from './fm-type.js';
import { glob } from 'glob';
import path from 'path';
import { remark } from 'remark';
import strip from 'strip-markdown';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import rehypeHyperlink from './rehype-hyperlink.js';
import remarkGfm from 'remark-gfm';
import { SKIP, visit } from 'unist-util-visit';
import rehypeSlug from 'rehype-slug';
import chalk from 'chalk';
import shiki, { Highlighter } from 'shiki';
import rehypeShiki from './rehype-shiki.js';
import lodash from 'lodash';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import _minifyHtml from '@minify-html/node';

const FOOTNOTE_LABEL = '각주';
const FOOTNOTE_BACKLABEL = '돌아가기';

let shikiHighlighter: Highlighter;
const validate = TypeCompiler.Compile(FrontMatterYaml);

program
  .option(
    '--posts <name>',
    'Specify the file name of posts collection.',
    'posts'
  )
  .option('-f, --force', 'Process all markdowns freshly.')
  .argument('<input-dir>')
  .argument('<out-dir>')
  .action(newMarkdownProcessor);
program.parse();

function errBegin(msg: string, file?: string) {
  console.error(chalk.bold(chalk.red(msg), file && chalk.whiteBright(file)));
}

function errBody(msg: string) {
  console.error(chalk.whiteBright(msg));
}

function errBody2(msg: string) {
  console.error(chalk.bold(chalk.yellow(msg)));
}

function errBody3(msg: string) {
  console.error(chalk.red(msg));
}

function timer() {
  const start = process.hrtime.bigint();
  return {
    timeMs() {
      const micro = BigInt(1000);
      const diff = (process.hrtime.bigint() - start) / micro;
      const n = Number(diff);
      return n / 1000;
    }
  };
}

async function newMarkdownProcessor(
  inDir: string,
  outDir: string,
  { posts: postsName, force }: { posts: string; force: boolean }
) {
  shikiHighlighter = await shiki.getHighlighter({
    theme: 'css-variables',
  });

  const took = timer();

  const inDirFiles = await glob(path.join(inDir, '**/*.md'));

  const nameCheck = checkFilenamesRegex(inDirFiles);
  if (nameCheck.length !== 0) {
    errBegin('The following file names are not valid');
    for (const err of nameCheck) {
      errBody(' - ' + err);
    }
    return;
  }
  const dupCheck = checkDuplicates(inDirFiles);
  if (dupCheck) {
    errBegin('The following files have duplicated name');
    for (const [name, paths] of Object.entries(dupCheck)) {
      errBody2(name + ':');
      errBody(paths.map((path) => ' - ' + path).join('\n'));
    }
    return;
  }

  // Except posts.json
  const outDirFiles = (await glob(path.join(outDir, '*.json'))).filter(
    (file) => {
      return path.parse(file).name !== postsName;
    }
  );
  const res = await diff(outDirFiles, inDirFiles);
  await rmAll(res.case3.map((v) => v.processedFile));
  const needToProcess = [
    ...res.case2,
    ...res.case4,
    ...(force ? res.case1 : []),
  ].map((file) => file.originalFile);
  const result: ContentType[] = [];
  let errored = false;
  await asyncFor(needToProcess, async (md) => {
    const processed = await processMd(md).catch((err) => {
      errBegin('An error has found on', md);
      errBody3(String(err));
      errored = true;
    });
    if (!processed) return;
    result.push(processed);
  });

  if (errored) return;

  console.log(
    chalk.cyan(`Processed ${result.length} markdowns in ${took.timeMs()}ms`)
  );

  await asyncFor(result, (val) => {
    return fs.writeFile(
      path.join(outDir, val.name + '.json'),
      JSON.stringify(val)
    );
  });

  const posts = generatePostsjson(result);
  await asyncFor(force ? [] : res.case1, async ({ processedFile: file }) => {
    const content = (await fs.readFile(file)).toString('utf-8');
    posts.push(...generatePostsjson([JSON.parse(content)]));
  });

  // Sort posts with writtenDate in descending order
  posts.sort((a, b) => {
    const dateA = new Date(a.metadata.writtenDate);
    const dateB = new Date(b.metadata.writtenDate);
    if (dateA < dateB) return 1;
    if (dateB < dateA) return -1;
    return 0;
  });

  await fs.writeFile(
    path.join(outDir, postsName + '.json'),
    JSON.stringify(posts)
  );
}

/**
 * Extracts front matter from markdown.
 * @param markdown Markdown content.
 * @returns An object with two properties.
 * 'markdown' is markdown with fromt matter extracted (removed),
 * And 'parsedFm' is the parsed front matter.
 * 'parsedFm' may be undefined if no front matter is detected.
 */
async function extractFrontMatter(markdown: string) {
  // TODO: Maybe it shouldn't parse the entire markdown?
  // Just only parse the front matter part.

  let frontMatter: unknown;

  const processed = await remark()
    .use(remarkFrontmatter, ['yaml'])
    .use(() => (tree, vfile, next) => {
      visit(tree, 'yaml', (node, index, parent) => {
        // It will never parse multiple front matters. Don't need to check multiples.
        frontMatter = parse(node.value);

        // Remove this node https://unifiedjs.com/learn/recipe/remove-node/
        parent!.children.splice(index!, 1);
        return [SKIP, index];
      });
      next();
    })
    .process(markdown);

  return {
    /**
     * Markdown without front matter
     */
    markdown: String(processed),
    /**
     * Parsed front matter. Can be undefined if no front matter is detected.
     */
    frontMatter,
  };
}

/**
 * Hopefully better implementation than before..
 * @param filePath Markdown file to process
 * @return null if it is set to draft
 * @throws If there's problem with markdown file
 */
async function processMd(filePath: string): Promise<ContentType | null> {
  const name = getName(filePath);
  const fileContent = (await fs.readFile(filePath)).toString('utf-8');

  const { markdown, frontMatter } = await extractFrontMatter(fileContent);
  if (!frontMatter) throw new Error('No front-matter detected');

  const valid = validate.Check(frontMatter);
  if (!valid) {
    const errors: string[] = [];
    for (const err of validate.Errors(frontMatter)) {
      errors.push(util.format(err));
    }
    throw new Error('Front-matter validation failure\n' + errors.join('\n'));
  }

  if (frontMatter.draft) return null;

  const html = await remark()
    .use(remarkGfm)
    .use(remarkRehype, { footnoteLabel: FOOTNOTE_LABEL, footnoteBackLabel: FOOTNOTE_BACKLABEL, allowDangerousHtml: true })
    .use(rehypeSlug)
    .use(rehypeShiki, { highlighter: shikiHighlighter, fatalOnError: true })
    .use(rehypeHyperlink)
    .use(rehypeStringify, { allowDangerousHtml: true })
    // It will create and process with its own VFile with immutable string.
    // If we pass VFile directly, it will modify that VFile, which we don't want.
    .process(markdown);

  frontMatter.writtenDate = new Date(frontMatter.writtenDate).toISOString();

  const stripped = String(await remark().use(strip).process(markdown)).replace(
    /\n+/g,
    ' '
  );
  const description =
    frontMatter.description ??
    `${stripped.slice(0, 100).trim()}${stripped.length > 100 ? '...' : ''}`;

  return {
    content: minifyHtml(String(html)),
    name,
    metadata: {
      description,
      ...lodash.omit(frontMatter, FrontMatterOptionalStrippedProperties),
    },
    unlisted: frontMatter.unlisted ? true : undefined,
  };
}

/**
 * Get name of this markdown (based on file name)
 * @param filePath Path to markdown file.
 * @returns The name.
 */
function getName(filePath: string) {
  const res = getNameOptional(filePath);
  if (typeof res === 'undefined') throw new Error('Invalid post name from path: ' + filePath);
  return res;
}

function getNameOptional(filePath: string) {
  const name = path.parse(filePath).name;
  if (PostNameRegex.test(name)) return name;
  const match = name.matchAll(FromFileName);
  let result;
  for (const mr of match) {
    if (result) return;
    result = mr[1];
  }
  return result;
}

/**
 * Omits content from each ContentType.
 */
function generatePostsjson(result: ContentType[]) {
  return result.reduce((prev, cur) => {
    if (cur.unlisted) return prev;
    prev.push(lodash.omit(cur, ['content']));
    return prev;
  }, [] as PostsListType);
}

interface DiffEntry {
  name: string;
  /**
   * The processed markdown json.
   */
  processedFile: string;
  /**
   * The original markdown file.
   */
  originalFile: string;
}

interface DiffResult {
  /**
   * Case 1 - Processed file is newer than original file.
   * Don't need to process.
   */
  case1: DiffEntry[];
  /**
   * Case 2 - Professed file is older than original file.
   * Need to freshly process.
   */
  case2: DiffEntry[];
  /**
   * Case 3 - Processed file exists, but original file not exists.
   * Need to remove the processed file.
   */
  case3: Omit<DiffEntry, 'originalFile'>[];
  /**
   * Case 4 - Processed file not exists, but orignal file exists.
   * Need to newly process. This may caused by 'draft' property on front matter.
   */
  case4: Omit<DiffEntry, 'processedFile'>[];
}

/**
 * Computes difference from two list of files. Make sure there is no duplicates on both.
 * @returns DiffResult object.
 */
async function diff(
  processeds: string[],
  originals: string[]
): Promise<DiffResult> {
  const result: DiffResult = {
    case1: [],
    case2: [],
    case3: [],
    case4: [],
  };
  const { case1, case2, case3, case4 } = result;

  const processedMap = new Map<
    string,
    { name: string; path: string; mtime: Date }
  >();
  await asyncFor(processeds, async (path) => {
    const name = getName(path);
    processedMap.set(name, {
      name,
      path,
      mtime: (await fs.stat(path)).mtime,
    });
  });

  const originalMap = new Map<
    string,
    { name: string; path: string; mtime: Date }
  >();
  await asyncFor(originals, async (path) => {
    const name = getName(path);
    originalMap.set(name, {
      name,
      path,
      mtime: (await fs.stat(path)).mtime,
    });
  });

  for (const [name, processedStat] of processedMap.entries()) {
    const originalStat = originalMap.get(name);

    // Case 1 and 2
    if (originalStat) {
      const caseEntry = {
        name,
        originalFile: originalStat.path,
        processedFile: processedStat.path,
      };

      if (processedStat.mtime > originalStat.mtime) {
        case1.push(caseEntry);
      } else {
        case2.push(caseEntry);
      }

      processedMap.delete(name);
      originalMap.delete(name);
    }
  }

  // Case 3
  for (const processedStat of processedMap.values()) {
    case3.push({
      name: processedStat.name,
      processedFile: processedStat.path,
    });
  }

  // Case 4
  for (const originalStat of originalMap.values()) {
    case4.push({
      name: originalStat.name,
      originalFile: originalStat.path,
    });
  }

  return result;
}

/**
 * Checks for file names that doesn't match PostNameRegex.
 * @param files File paths to check.
 * @returns Array of failed file paths. Empty if there was none.
 */
function checkFilenamesRegex(files: string[]) {
  return files.reduce((fails, path) => {
    const name = getNameOptional(path);
    if (typeof name === 'undefined') {
      fails.push(path);
    } else if (!PostNameRegex.test(name)) {
      fails.push(path);
    }
    return fails;
  }, [] as string[]);
}

/**
 * Checks for duplicated file names.
 * @param files File paths to check.
 * @returns If there's duplicates, returns key-value pair of duplicated name and corresponding file paths.
 */
function checkDuplicates(files: string[]) {
  const duplicateCheck = new Map<string, string[]>();
  files.forEach((path) => {
    const name = getName(path);
    const check = duplicateCheck.get(name);
    if (typeof check === 'undefined') {
      duplicateCheck.set(name, [path]);
    } else {
      check.push(path);
    }
  });

  let success = true;

  const fails: Record<string, string[]> = {};
  duplicateCheck.forEach((value, key) => {
    if (value.length !== 1) {
      success = false;
      fails[key] = value;
    }
  });

  return success ? undefined : fails;
}

function minifyHtml(html: string): string {
  const buf = _minifyHtml.minify(Buffer.from(html), { minify_css: true });
  return buf.toString('utf-8');
}

async function rmAll(paths: string[]) {
  return asyncFor(paths, (path) => fs.rm(path));
}

async function asyncFor<T, R>(arr: T[], f: (_: T) => Promise<R>): Promise<R[]> {
  return await Promise.all(arr.map(f));
}
