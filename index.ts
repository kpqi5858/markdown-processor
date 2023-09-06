import { parse } from 'yaml';
import fs from 'fs/promises';
import util from 'util';
import { program } from 'commander';
import {
  ContentType,
  FrontMatterOptionalStrippedProperties,
  FrontMatterYaml,
  Metadata,
  MetadataType,
} from './fm-type.js';
import {
  asyncFor,
  checkDuplicates,
  checkFilenames,
  diff,
  getName,
  minifyHtml,
  rmAll,
  generatePostsjson,
  stripMarkdown,
} from './utils.js';
import { glob } from 'glob';
import path from 'path';
import { remark } from 'remark';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import rehypeKatex from 'rehype-katex';
import rehypeHyperlink, { LocalLinkValidator } from './rehype-hyperlink.js';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { SKIP, visit } from 'unist-util-visit';
import rehypeSlug from 'rehype-slug';
import chalk from 'chalk';
import shiki, { Highlighter } from 'shiki';
import rehypeShiki from './rehype-shiki.js';
import lodash from 'lodash';
import { TypeCompiler } from '@sinclair/typebox/compiler';

const FOOTNOTE_LABEL = '각주';
const FOOTNOTE_BACKLABEL = '돌아가기';
const METADATA_NAME = 'meta';

let shikiHighlighter: Highlighter;
const validate = TypeCompiler.Compile(FrontMatterYaml);
const metaValidate = TypeCompiler.Compile(Metadata);

program
  .option(
    '--posts <name>',
    'Specify the file name of posts collection.',
    'posts',
  )
  .option('--metadata <path>', 'Metadata path.')
  .option('-f, --force', 'Process all markdowns freshly.')
  .argument('<input-dir>')
  .argument('<out-dir>')
  .action(markdownProcessor);
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
      const micro = 1000n;
      const diff = (process.hrtime.bigint() - start) / micro;
      const n = Number(diff);
      return n / 1000;
    },
  };
}

async function markdownProcessor(
  inDir: string,
  outDir: string,
  {
    posts: postsName,
    metadata: metadataPath,
    force,
  }: { posts: string; metadata: string | undefined; force: boolean },
) {
  shikiHighlighter = await shiki.getHighlighter({
    theme: 'css-variables',
  });

  const took = timer();

  let metadata: MetadataType | undefined;
  try {
    if (metadataPath) metadata = await loadMetadata(metadataPath);
  } catch (e: unknown) {
    errBegin('Failed to read metadata info at ' + metadataPath);
    errBody3(String(e));
    return;
  }

  const inDirFiles = await glob(path.join(inDir, '**/*.md'));

  const nameCheck = checkFilenames(inDirFiles, [
    postsName,
    ...(metadata ? [METADATA_NAME, postsName] : []),
  ]);
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

  const postNames = new Set(inDirFiles.map(getName));

  // Except posts.json
  const outDirFiles = (await glob(path.join(outDir, '*.json'))).filter(
    (file) => {
      return path.parse(file).name !== postsName;
    },
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
    const processed = await processMd(
      md,
      (l) => postNames.has(l),
      metadata,
    ).catch((err) => {
      errBegin('An error has found on', md);
      errBody3(String(err));
      errored = true;
    });
    if (!processed) return;
    result.push(processed);
  });

  if (errored) return;

  console.log(
    chalk.cyan(`Processed ${result.length} markdowns in ${took.timeMs()}ms`),
  );

  await asyncFor(result, (val) => {
    return fs.writeFile(
      path.join(outDir, val.name + '.json'),
      JSON.stringify(val),
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
    JSON.stringify(posts),
  );

  if (metadata)
    await fs.writeFile(
      path.join(outDir, METADATA_NAME + '.json'),
      JSON.stringify(metadata),
    );
  else await rmAll([path.join(outDir, METADATA_NAME + '.json')]);
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

  const processed = remark()
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
    .processSync(markdown);

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
async function processMd(
  filePath: string,
  isValidLocalLink: LocalLinkValidator,
  metadata?: MetadataType,
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
    throw new Error('Front-matter validation failure\n' + errors.join('\n'));
  }

  if (metadata) {
    const errors = [];
    if (
      frontMatter.series != null &&
      metadata.series[frontMatter.series] == null
    )
      errors.push(`Series '${frontMatter.series}' is not found in metadata`);
    for (const ct of frontMatter.category ?? []) {
      if (metadata.categories[ct] == null)
        errors.push(`Category '${ct}' is not found in metadata`);
    }
    if (errors.length) throw new Error(errors.join('\n'));
  }
  if (frontMatter.draft) return null;

  const html = await remark()
    .use(remarkGfm)
    .use(remarkRehype, {
      footnoteLabel: FOOTNOTE_LABEL,
      footnoteBackLabel: FOOTNOTE_BACKLABEL,
      allowDangerousHtml: true,
    })
    .use(rehypeSlug)
    .use(remarkMath)
    .use(rehypeShiki, { highlighter: shikiHighlighter, fatalOnError: true })
    .use(rehypeKatex)
    .use(rehypeHyperlink, { isValidLocalLink })
    .use(rehypeStringify, { allowDangerousHtml: true })
    // It will create and process with its own VFile with immutable string.
    // If we pass VFile directly, it will modify that VFile, which we don't want.
    .process(markdown);

  frontMatter.writtenDate = new Date(frontMatter.writtenDate).toISOString();

  const stripped = stripMarkdown(markdown);
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

async function loadMetadata(path: string) {
  const content = (await fs.readFile(path)).toString('utf-8');
  const y = parse(content);
  if (metaValidate.Check(y)) {
    return y;
  }
  const errors: string[] = [];
  for (const err of metaValidate.Errors(y)) {
    errors.push(util.format(err));
  }
  throw new Error('Metadata validation failure\n' + errors.join('\n'));
}

export default markdownProcessor;
