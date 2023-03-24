import { parse } from 'yaml';
import fs from 'fs/promises';
import util from 'util';
import { program } from 'commander';
import {
  ContentType,
  FrontMatterOptionalStrippedProperties,
  FrontMatterYaml,
  PostNameRegex,
  PostsListType
} from './fm-type.js';
import _glob from 'glob';
import path from 'path';
import { promisify } from 'util';
import { remark } from 'remark';
import strip from 'strip-markdown';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { SKIP, visit } from 'unist-util-visit';
import rehypePresetMinify from 'rehype-preset-minify';
import rehypeSlug from 'rehype-slug';
import chalk from 'chalk';
import shiki, { Highlighter } from 'shiki';
import rehypeShiki from './rehype-shiki.js';
import lodash from 'lodash';
import { TypeCompiler } from '@sinclair/typebox/compiler';

let shikiHighlighter: Highlighter;
const glob = promisify(_glob);
const validate = TypeCompiler.Compile(FrontMatterYaml);

program
.option('--posts <name>', 'Specify the file name of posts collection.', 'posts')
.argument('<input-dir>').argument('<out-dir>').action(markdownProcessor);
program.parse();

async function markdownProcessor(postsName: string, inDir: string, outDir: string) {
  shikiHighlighter = await shiki.getHighlighter({
    theme: 'material-palenight'
  });

  const inDirFiles = await glob(path.join(inDir, '**/*.md'));
  const result: ContentType[] = [];
  const duplicateCheck = new Map<string, string[]>();

  let errored = false;

  for (const mdFile of inDirFiles) {
    const processed = await processMd(mdFile).catch((err) => {
      console.error(
        chalk.red.bold('An error has found on'),
        chalk.bold(mdFile)
      );
      console.error(chalk.red('->', err));
      errored = true;
    });
    if (!processed) continue;

    const check = duplicateCheck.get(processed.name);
    if (typeof check === 'undefined') {
      duplicateCheck.set(processed.name, [mdFile]);
    } else {
      check.push(mdFile);
    }

    result.push(processed);
  }

  duplicateCheck.forEach((value, key) => {
    if (value.length !== 1) {
      console.error(chalk.red.bold('Duplicate name found:'), chalk.bold(key));
      value.forEach((file) => console.error(chalk.red(file)));
      errored = true;
    }
  });

  if (errored) process.exit(1);

  // Sort posts with writtenDate in descending order
  result.sort((a, b) => {
    const dateA = new Date(a.metadata.writtenDate);
    const dateB = new Date(b.metadata.writtenDate);
    if (dateA < dateB) return 1;
    if (dateB < dateA) return -1;
    return 0;
  });

  console.log(chalk.cyan(`Processed ${result.length} markdowns`));

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir);

  await Promise.all(
    result.map(async (val) => {
      await fs.writeFile(
        path.join(outDir, val.name + '.json'),
        JSON.stringify(val)
      );
    })
  );

  await fs.writeFile(
    path.join(outDir, postsName + '.json'),
    JSON.stringify(generatePostsjson(result))
  )
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
        // @ts-expect-error It should be never null, unless we are dealing with root directly.
        parent.children.splice(index, 1);
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
    frontMatter
  };
}

/**
 * Hopefully better implementation than before..
 * @param filePath Markdown file to process
 * @return null if it is set to noPublish
 * @throws If there's problem with markdown file
 */
async function processMd(
  filePath: string
): Promise<ContentType | null> {
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
    throw new Error(
      'Front-matter validation failure\n' + errors.join('\n')
    );
  }

  if (frontMatter.noPublish) return null;

  const html = await remark()
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeShiki, { highlighter: shikiHighlighter, fatalOnError: true })
    .use(rehypePresetMinify)
    .use(rehypeStringify)
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
    content: String(html),
    name,
    metadata: {
      description,
      ...lodash.omit(frontMatter, FrontMatterOptionalStrippedProperties)
    },
    unlisted: frontMatter.unlisted ? true : undefined
  };
}

/**
 * Get name of this markdown (based on file name)
 * @param filePath Path to markdown file.
 * @returns The name.
 */
function getName(filePath: string) {
  return path.parse(filePath).name;
}

/**
 * Omits content from each ContentType.
 */
function generatePostsjson(result: ContentType[]) {
  return result.reduce((prev, cur) => {
    if (cur.unlisted) return prev;
    prev.push(lodash.omit(cur, ['content']));
    return prev;
  }, [] as PostsListType)
}


interface DiffEntry {
  /**
   * The processed markdown json.
   */
  processedFile: string,
  /**
   * The original markdown file.
   */
  originalFile: string
};

interface DiffResult {
  /**
   * Case 1 - Processed file is newer than original file.
   * Don't need to process.
   */
  case1: DiffEntry[],
  /**
   * Case 2 - Professed file is older than original file.
   * Need to freshly process.
   */
  case2: DiffEntry[],
  /**
   * Case 3 - Processed file exists, but original file not exists.
   * Need to remove the processed file.
   */
  case3: Omit<DiffEntry, 'originalFile'>[],
  /**
   * Case 4 - Processed file not exists, but orignal file exists.
   * Need to newly process. This may caused by 'noPublish' property on front matter.
   */
  case4: Omit<DiffEntry, 'processedFile'>[]
};

/**
 * Computes difference from two list of files. Make sure there is no duplicates on both.
 * @returns DiffResult object.
 */
async function diff(processeds: string[], originals: string[]): Promise<DiffResult> {
  const result: DiffResult = {
    case1: [],
    case2: [],
    case3: [],
    case4: []
  };
  const { case1, case2, case3, case4 } = result;

  const processedMap = new Map<string, { path: string, mtime: Date }>();
  for (const path of processeds) {
    processedMap.set(getName(path), {
      path,
      mtime: (await fs.stat(path)).mtime
    });
  }

  const originalMap = new Map<string, { path: string, mtime: Date }>();
  for (const path of originals) {
    originalMap.set(getName(path), {
      path,
      mtime: (await fs.stat(path)).mtime
    });
  }

  for (const [name, processedStat] of processedMap.entries()) {
    const originalStat = originalMap.get(name);

    // Case 1 and 2
    if (originalStat) {
      const caseEntry = {
        originalFile: originalStat.path,
        processedFile: processedStat.path
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
      processedFile: processedStat.path
    });
  }

  // Case 4
  for (const originalStat of originalMap.values()) {
    case4.push({
      originalFile: originalStat.path
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
    if (!PostNameRegex.test(getName(path))) {
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

export { markdownProcessor, processMd };
