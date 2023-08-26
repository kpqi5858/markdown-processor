import { Root } from 'hast';
import { Plugin } from 'unified';
import { CONTINUE, visit } from 'unist-util-visit';

const plugin: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'element', (node) => {
      if (node.tagName != 'a') return;
      const href = node.properties?.href;
      if (typeof href === 'string') {
        node.properties ??= {};
        if (!href.startsWith('./') && !href.startsWith('#')) {
          Object.assign(node.properties, {
            target: '_blank',
            rel: 'noreferrer noopener',
            ['data-extlink']: null
          });
        }
      }
      return [CONTINUE];
    });
  };
};

export default plugin;
