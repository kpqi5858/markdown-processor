import { parse } from 'yaml';
import fs from 'fs/promises';
import { program } from 'commander';
import { ContentType, FrontMatterYaml, FrontMatterYamlType } from './fm-type.js';
import _Ajv from 'ajv';
import _glob from 'glob';
import path from 'path';
import { promisify } from 'util';
import { nanoid } from 'nanoid';
import { remark } from 'remark';
import strip from 'strip-markdown';
import { unified } from 'unified';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import { SKIP, visit } from 'unist-util-visit';
import remarkStringify from 'remark-stringify';
import rehypePresetMinify from 'rehype-preset-minify';
import rehypeSlug from 'rehype-slug';

const glob = promisify(_glob);
const Ajv = new _Ajv();
const validate = Ajv.compile(FrontMatterYaml);

const randomIds: string[] = [];

program.argument('<input-dir>').argument('<out-dir>').action(async (inDir, outDir) => {
  await fs.rm(outDir, { recursive: true });
  await fs.mkdir(outDir);

  const inDirFiles = await glob(path.join(inDir, '**/*.md'));
  randomIds.push(...getRandomIds(inDirFiles.length));

  // I "filter" null objects..
  const result = (await Promise.all(inDirFiles.map(processMd))).filter((val) => val != null) as ContentType[];

  result.sort((a, b) => {
    const dateA = new Date(a.metadata.writtenDate);
    const dateB = new Date(b.metadata.writtenDate);
    if (dateA < dateB) return -1;
    if (dateB < dateA) return 1;
    return 0;
  });

  console.log(`Processed ${result.length} markdowns`);

  await Promise.all(result.map(async (val) => {
    await fs.writeFile(path.join(outDir, val.id + '.json'), JSON.stringify(val));
  }));
  await fs.writeFile(path.join(outDir, 'posts.json'), JSON.stringify(result.map((val) => {
    const {content: _, ...omitted} = val;
    return omitted;
  })));
});

program.parse();


/**
 * Hopefully better implementation than before..
 * @param filePath Markdown file to process
 * @return null if it is set to noPublish
 * @throws If there's problem with markdown file
 */
async function processMd(filePath: string): Promise<ContentType | null> {
  const fileContent = await fs.readFile(filePath);

  // Typescript is broken..
  let fmYaml: FrontMatterYamlType | undefined;

  const processed = await unified()
  .use(remarkParse)
  .use(remarkStringify)
  .use(remarkFrontmatter, ['yaml'])
  .use(() => (tree, vfile, next) => {
    visit(tree, 'yaml', (node, index, parent) => {
      if (index == null || parent == null) throw new Error('Unexpected null parameter');
      if (fmYaml) throw new Error('Multiple front-matter parsed');

      fmYaml = parse(node.value);
      const valid = validate(fmYaml);
      if (!valid) {
        console.error(`${filePath} front-matter validation failed.`);
        console.error(validate.errors);
        throw new Error('Validation failure');
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
  .use(rehypeStringify)
  .use(rehypeSlug)
  .use(rehypePresetMinify)
  // If we don't deep-copy like this, it will affect "processed" object. Therefore "stripped" won't work.
  .process(String(processed));

  fmYaml.writtenDate = new Date(fmYaml.writtenDate).toISOString();

  const randomId = randomIds.pop();
  if (typeof randomId === 'undefined') throw new Error('wtf not enough available randomIds');

  const { noPublish: _, ...omittedFm } = fmYaml;

  const stripped = String(await remark().use(strip).process(processed)).replace(/\n+/g, ' ');
  const description = omittedFm.description ?? `${stripped.slice(0, 100).trim()}${stripped.length > 100 ? '...' : ''}`;

  return {
    id: randomId,
    content: String(html),
    name: path.parse(filePath).name,
    metadata: {
      description,
      ...omittedFm
    }
  };
}

function getRandomId() {
  // Maybe I could try implementing this my own
  return nanoid(8);
}

function getRandomIds(count: number): string[] {
  const set = new Set<string>();
  while (set.size < count) {
    set.add(getRandomId());
  }
  return Array.from(set);
}
