import { parse } from 'yaml';
import fs from 'fs/promises';
import util from 'util';
import { program } from 'commander';
import {
  ContentType,
  FrontMatterYaml,
  FrontMatterYamlType,
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

interface ProcessedMarkdownResult {
  content: ContentType;
  unlisted?: boolean;
}

let shikiHighlighter: Highlighter;
const glob = promisify(_glob);
const validate = TypeCompiler.Compile(FrontMatterYaml);

program.argument('<input-dir>').argument('<out-dir>').action(markdownProcessor);
program.parse();

async function markdownProcessor(inDir: string, outDir: string) {
  shikiHighlighter = await shiki.getHighlighter({
    theme: 'material-palenight'
  });

  const inDirFiles = await glob(path.join(inDir, '**/*.md'));
  const result: ProcessedMarkdownResult[] = [];
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

    const check = duplicateCheck.get(processed.content.name);
    if (typeof check === 'undefined') {
      duplicateCheck.set(processed.content.name, [mdFile]);
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
    const dateA = new Date(a.content.metadata.writtenDate);
    const dateB = new Date(b.content.metadata.writtenDate);
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
        path.join(outDir, val.content.name + '.json'),
        JSON.stringify(val.content)
      );
    })
  );

  await fs.writeFile(
    path.join(outDir, 'posts.json'),
    JSON.stringify(
      result.reduce((prev, cur) => {
        if (cur.unlisted) return prev;
        prev.push(lodash.omit(cur.content, ['content']));
        return prev;
      }, [] as PostsListType)
    )
  );
}

/**
 * Hopefully better implementation than before..
 * @param filePath Markdown file to process
 * @return null if it is set to noPublish
 * @throws If there's problem with markdown file
 */
async function processMd(
  filePath: string
): Promise<ProcessedMarkdownResult | null> {
  const fileContent = await fs.readFile(filePath);

  let fmYaml: FrontMatterYamlType | undefined;

  const processed = await remark()
    .use(remarkFrontmatter, ['yaml'])
    .use(() => (tree, vfile, next) => {
      visit(tree, 'yaml', (node, index, parent) => {
        if (index == null || parent == null)
          throw new Error('Unexpected null parameter');
        if (fmYaml) throw new Error('Multiple front-matter parsed');

        fmYaml = parse(node.value);
        const valid = validate.Check(fmYaml);
        if (!valid) {
          const errorMsg: string[] = [];
          for (const err of validate.Errors(fmYaml)) {
            errorMsg.push(util.format(err));
          }
          throw new Error(
            'Front-matter validation failure\n' + errorMsg.join('\n')
          );
        }

        // Remove this node https://unifiedjs.com/learn/recipe/remove-node/
        parent.children.splice(index, 1);
        return [SKIP, index];
      });
      next();
    })
    .process(fileContent);

  if (!fmYaml) throw new Error('No front-matter detected');
  if (fmYaml.noPublish) return null;

  const html = await remark()
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeShiki, { highlighter: shikiHighlighter, fatalOnError: true })
    .use(rehypePresetMinify)
    .use(rehypeStringify)
    // If we don't deep-copy like this, it will affect "processed" object. Therefore "stripped" won't work.
    .process(String(processed));

  fmYaml.writtenDate = new Date(fmYaml.writtenDate).toISOString();
  fmYaml.name ??= getName(filePath);

  if (!PostNameRegex.test(fmYaml.name))
    throw new Error(`name must match PostNameRegex: ${fmYaml.name}`);

  const name = fmYaml.name;
  const stripped = String(await remark().use(strip).process(processed)).replace(
    /\n+/g,
    ' '
  );
  const description =
    fmYaml.description ??
    `${stripped.slice(0, 100).trim()}${stripped.length > 100 ? '...' : ''}`;

  return {
    content: {
      content: String(html),
      name,
      metadata: {
        description,
        ...lodash.omit(fmYaml, ['name', 'noPublish', 'unlisted'])
      }
    },
    unlisted: fmYaml.unlisted
  };
}

function getName(filePath: string) {
  return path.parse(filePath).name;
}

export default markdownProcessor;
