import { CONTINUE, visit } from 'unist-util-visit';
const plugin = () => {
    return (tree) => {
        visit(tree, 'element', (node) => {
            if (node.tagName != 'a')
                return;
            const href = node.properties?.href;
            if (typeof href === 'string') {
                node.properties ??= {};
                if (!href.startsWith('./') && !href.startsWith('#')) {
                    Object.assign(node.properties, {
                        target: '_blank',
                        rel: 'noreferrer noopener',
                        ['data-extlink']: ''
                    });
                }
            }
            return [CONTINUE];
        });
    };
};
export default plugin;
