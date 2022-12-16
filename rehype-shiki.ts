import { Root, Element } from 'hast';
import { unified, Plugin } from 'unified';
import rehypeParse from 'rehype-parse';
import { toText } from 'hast-util-to-text';
import { visit } from 'unist-util-visit';
import { Highlighter} from 'shiki';

interface Options {
  /**
   * Shiki highlighter object.
   */
  highlighter: Highlighter;
  /**
   * Whether to fail when highlighting fails. Default is false.
   */
  fatalOnError?: boolean;
}

const hastParser = unified().use(rehypeParse, { fragment: true });

/**
 * Very hacky code highlighting with shiki.
 * Please don't use this code for your production..
 *
 * Yes, there's already rehype-shiki but I decided to rewrite with their sources.
 */
const rehypeShiki: Plugin<[Options], Root> = ({ highlighter, fatalOnError = false}) => {
  return (tree, vfile) => {
    visit(tree, 'element', (node, index, parent) => {
      // We are only selecting 'code' tag where parent is 'pre'
      if (
        !parent ||
        parent.type !== 'element' ||
        parent.tagName !== 'pre' ||
        node.tagName !== 'code' ||
        !node.properties
      )
        return;

      const className = node.properties.className;
      const lang = Array.isArray(className)
        ? getLanguage(className)
        : undefined;

      try {
        const highlightedHtml = highlighter.codeToHtml(toText(node), { lang });
        const parsed = hastParser.parse(highlightedHtml);
        const codeChildren = parsed.children[0];
        if (codeChildren.type !== 'element')
          throw new Error('Expected Element. Got ' + codeChildren.type);

        // Try to merge style on 'pre' tag.
        const codeTagStyle = codeChildren.properties?.style;
        if (typeof codeTagStyle === 'string')
          addStyle(parent, codeTagStyle);

        parent.children = codeChildren.children;
      } catch (e) {
        if (fatalOnError) {
          vfile.fail(e as Error);
          return;
        }
        vfile.message('Warning: Error occured while trying to highlight the code block.')
        vfile.message(e as Error);
      }
    });
  };
};

function getLanguage(node: (string | number)[]) {
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

function addStyle(node: Element, style: string) {
  const props = node.properties || {};

  props.style = props.style ? `${props.style};${style}` : style;
  node.properties = props;
}

export default rehypeShiki;
