import { visit } from 'unist-util-visit';
import { getName } from './utils.js';
function localLinkTransform(href, l) {
    // Check if href is an url
    try {
        new URL(href);
        return;
    }
    catch { }
    // If it's not, then assume it's local path
    href = decodeURI(href);
    const hash = href.indexOf('#');
    let hashPart = '';
    if (hash >= 0) {
        hashPart = href.slice(hash);
        href = href.slice(0, hash);
    }
    const name = getName(href);
    if (!l(name)) {
        throw new Error(`'${href}' is expected to be a valid local path`);
    }
    return './' + name + hashPart;
}
const plugin = ({ isValidLocalLink }) => {
    return (tree) => {
        visit(tree, 'element', (node) => {
            if (node.tagName != 'a')
                return;
            let href = node.properties?.href;
            if (typeof href !== 'string')
                return;
            if (href.startsWith('#'))
                return;
            node.properties ??= {};
            node.properties.href = href =
                localLinkTransform(href, isValidLocalLink) ?? href;
            if (!href.startsWith('./')) {
                Object.assign(node.properties, {
                    target: '_blank',
                    rel: 'noreferrer noopener',
                    ['data-extlink']: '',
                });
            }
        });
    };
};
export default plugin;
