import { parse } from 'yaml';
import fs from 'fs/promises';
import util from 'util';
import { program } from 'commander';
import { ContentType, FrontMatterYaml, FrontMatterYamlType } from './fm-type.js';
import _Ajv from 'ajv';
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

const glob = promisify(_glob);
const Ajv = new _Ajv();
const validate = Ajv.compile(FrontMatterYaml);

program.argument('<input-dir>').argument('<out-dir>').action(markdownProcessor);
program.parse();

async function markdownProcessor(inDir: string, outDir: string) {
  await fs.rm(outDir, { recursive: true });
  await fs.mkdir(outDir);

  const inDirFiles = await glob(path.join(inDir, '**/*.md'));
  const result: ContentType[] = [];
  const duplicateCheck = new Map<string, string[]>();

  let errored = false;

  for (const mdFile of inDirFiles) {
    const processed = await processMd(mdFile).catch((err) => {
      console.error(chalk.red.bold('An error has found on'), chalk.bold(mdFile));
      console.error(chalk.red(err));
      errored = true;
    });
    if (processed == null) continue;

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

  result.sort((a, b) => {
    const dateA = new Date(a.metadata.writtenDate);
    const dateB = new Date(b.metadata.writtenDate);
    if (dateA < dateB) return -1;
    if (dateB < dateA) return 1;
    return 0;
  });

  console.log(chalk.cyan(`Processed ${result.length} markdowns`));

  await Promise.all(result.map(async (val) => {
    await fs.writeFile(path.join(outDir, val.name + '.json'), JSON.stringify(val));
  }));
  await fs.writeFile(path.join(outDir, 'posts.json'), JSON.stringify(result.map((val) => {
    const {content: _, ...omitted} = val;
    return omitted;
  })));
}

/**
 * Hopefully better implementation than before..
 * @param filePath Markdown file to process
 * @return null if it is set to noPublish
 * @throws If there's problem with markdown file
 */
async function processMd(filePath: string): Promise<ContentType | null> {
  const fileContent = await fs.readFile(filePath);

  let fmYaml: FrontMatterYamlType | undefined;

  const processed = await remark()
  .use(remarkFrontmatter, ['yaml'])
  .use(() => (tree, vfile, next) => {
    visit(tree, 'yaml', (node, index, parent) => {
      if (index == null || parent == null) throw new Error('Unexpected null parameter');
      if (fmYaml) throw new Error('Multiple front-matter parsed');

      fmYaml = parse(node.value);
      const valid = validate(fmYaml);
      if (!valid) throw new Error(`Front-matter validation failure\n${util.format(validate.errors)}`);

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
  .use(rehypeStringify)
  .use(rehypeSlug)
  .use(rehypePresetMinify)
  // If we don't deep-copy like this, it will affect "processed" object. Therefore "stripped" won't work.
  .process(String(processed));

  fmYaml.writtenDate = new Date(fmYaml.writtenDate).toISOString();
  fmYaml.name ??= getName(filePath);

  const { noPublish: _, name, ...omittedFm } = fmYaml;

  const stripped = String(await remark().use(strip).process(processed)).replace(/\n+/g, ' ');
  const description = omittedFm.description ?? `${stripped.slice(0, 100).trim()}${stripped.length > 100 ? '...' : ''}`;

  return {
    content: String(html),
    name,
    metadata: {
      description,
      ...omittedFm
    }
  };
}

function getName(filePath: string) {
  return path.parse(filePath).name;
}
