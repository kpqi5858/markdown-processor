import path from 'path';
import { FromFileName, PostNameRegex, } from './fm-type.js';
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
export function getName(filePath) {
    const res = getNameOptional(filePath);
    if (typeof res === 'undefined')
        throw new Error('Invalid post name from path: ' + filePath);
    return res;
}
export function getNameOptional(filePath) {
    const name = path.parse(filePath).name;
    if (PostNameRegex.test(name))
        return name;
    const match = name.matchAll(FromFileName);
    let result;
    for (const mr of match) {
        if (result)
            return;
        result = mr[1];
    }
    return result;
}
export function stripMarkdown(markdown) {
    return String(stripMarkdownProcessor.processSync(markdown)).replace(/\n+/g, ' ');
}
/**
 * Omits content from each ContentType.
 */
export function generatePostsjson(result) {
    return result.reduce((prev, cur) => {
        if (cur.unlisted)
            return prev;
        prev.push(lodash.omit(cur, ['content']));
        return prev;
    }, []);
}
/**
 * Computes difference from two list of files. Make sure there is no duplicates on both.
 * @returns DiffResult object.
 */
export async function diff(processeds, originals) {
    const result = {
        case1: [],
        case2: [],
        case3: [],
        case4: [],
    };
    const { case1, case2, case3, case4 } = result;
    const processedMap = new Map();
    await asyncFor(processeds, async (path) => {
        const name = getName(path);
        processedMap.set(name, {
            name,
            path,
            mtime: (await fs.stat(path)).mtime,
        });
    });
    const originalMap = new Map();
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
            }
            else {
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
export function checkFilenames(files, bannedName = []) {
    return files.reduce((fails, path) => {
        const name = getNameOptional(path);
        if (typeof name === 'undefined') {
            fails.push(path);
        }
        else if (bannedName.includes(name)) {
            fails.push(path);
        }
        else if (!PostNameRegex.test(name)) {
            fails.push(path);
        }
        return fails;
    }, []);
}
/**
 * Checks for duplicated file names.
 * @param files File paths to check.
 * @returns If there's duplicates, returns key-value pair of duplicated name and corresponding file paths.
 */
export function checkDuplicates(files) {
    const duplicateCheck = new Map();
    files.forEach((path) => {
        const name = getName(path);
        const check = duplicateCheck.get(name);
        if (typeof check === 'undefined') {
            duplicateCheck.set(name, [path]);
        }
        else {
            check.push(path);
        }
    });
    let success = true;
    const fails = {};
    duplicateCheck.forEach((value, key) => {
        if (value.length !== 1) {
            success = false;
            fails[key] = value;
        }
    });
    return success ? undefined : fails;
}
export function minifyHtml(html) {
    const buf = _minifyHtml.minify(Buffer.from(html), { minify_css: true });
    return buf.toString('utf-8');
}
export async function rmAll(paths) {
    return asyncFor(paths, (path) => fs.rm(path, { force: true }));
}
export async function asyncFor(arr, f) {
    return await Promise.all(arr.map(f));
}
