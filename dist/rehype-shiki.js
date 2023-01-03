import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import { toText } from 'hast-util-to-text';
import { SKIP, visit } from 'unist-util-visit';
const hastParser = unified().use(rehypeParse, { fragment: true });
/**
 * Very hacky code highlighting with shiki.
 * Please don't use this code for your production..
 *
 * Yes, there's already rehype-shiki but I decided to rewrite with their sources.
 */
const rehypeShiki = ({ highlighter, fatalOnError = false }) => {
    return (tree, vfile) => {
        visit(tree, 'element', (node, index, parent) => {
            // We are only selecting 'code' tag where parent is 'pre'
            if (parent?.type !== 'element' ||
                parent.tagName !== 'pre' ||
                node.tagName !== 'code')
                return;
            const className = node.properties?.className;
            const lang = Array.isArray(className)
                ? getLanguage(className)
                : undefined;
            try {
                const highlightedHtml = highlighter.codeToHtml(toText(node, { whitespace: 'pre' }), { lang });
                const parsed = hastParser.parse(highlightedHtml);
                const codeChildren = parsed.children[0];
                if (codeChildren.type !== 'element')
                    throw new Error('Expected Element. Got ' + codeChildren.type);
                // Try to merge style on 'pre' tag.
                const codeTagStyle = codeChildren.properties?.style;
                if (typeof codeTagStyle === 'string')
                    addStyle(parent, codeTagStyle);
                // Replace the node with parsed children https://unifiedjs.com/learn/recipe/remove-node/
                parent.children.splice(index, 1, ...codeChildren.children);
                return [SKIP, index];
            }
            catch (e) {
                if (fatalOnError) {
                    vfile.fail(e);
                    return;
                }
                vfile.message('Warning: Error occured while trying to highlight the code block.');
                vfile.message(e);
            }
        });
    };
};
function getLanguage(node) {
    for (const className of node) {
        const value = String(className);
        if (value === 'no-highlight' || value === 'nohighlight') {
            return;
        }
        if (value.slice(0, 5) === 'lang-') {
            return value.slice(5);
        }
        if (value.slice(0, 9) === 'language-') {
            return value.slice(9);
        }
    }
}
function addStyle(node, style) {
    const props = node.properties || {};
    props.style = props.style ? `${props.style};${style}` : style;
    node.properties = props;
}
export default rehypeShiki;
