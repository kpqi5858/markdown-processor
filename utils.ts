import path from 'path';
import {
  ContentType,
  FromFileName,
  PostNameRegex,
  PostsListType,
} from './fm-type.js';
import fs from 'fs/promises';
import _minifyHtml from '@minify-html/node';
import lodash from 'lodash';
import { remark } from 'remark';
import strip from 'strip-markdown';

const stripMarkdownProcessor = remark().use(strip);

/**
 * Get name of this markdown (based on file name)
 * @param filePath Path to markdown file.
 * @returns The name.
 */
export function getName(filePath: string) {
  const res = getNameOptional(filePath);
  if (typeof res === 'undefined')
    throw new Error('Invalid post name from path: ' + filePath);
  return res;
}

export function getNameOptional(filePath: string) {
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

export function stripMarkdown(markdown: string) {
  return String(stripMarkdownProcessor.processSync(markdown)).replace(
    /\n+/g,
    ' ',
  );
}

/**
 * Omits content from each ContentType.
 */
export function generatePostsjson(result: ContentType[]) {
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
export async function diff(
  processeds: string[],
  originals: string[],
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
export function checkFilenames(files: string[], bannedName: string[] = []) {
  return files.reduce((fails, path) => {
    const name = getNameOptional(path);
    if (typeof name === 'undefined') {
      fails.push(path);
    } else if (bannedName.includes(name)) {
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
export function checkDuplicates(files: string[]) {
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

export function minifyHtml(html: string): string {
  const buf = _minifyHtml.minify(Buffer.from(html), { minify_css: true });
  return buf.toString('utf-8');
}

export async function rmAll(paths: string[]) {
  return asyncFor(paths, (path) => fs.rm(path, { force: true }));
}

export async function asyncFor<T, R>(
  arr: T[],
  f: (_: T) => Promise<R>,
): Promise<R[]> {
  return await Promise.all(arr.map(f));
}
