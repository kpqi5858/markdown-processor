import { Root } from 'hast';
import { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import { getName } from './utils.js';

export type LocalLinkValidator = (l: string) => boolean;

interface PluginOption {
  isValidLocalLink: LocalLinkValidator;
}

function localLinkTransform(
  href: string,
  l: LocalLinkValidator,
): string | undefined {
  // Check if href is an url
  try {
    new URL(href);
    return;
  } catch {}

  // If it's not, then assume it's local path
  href = decodeURI(href);
  const name = getName(href);
  if (!l(name)) {
    throw new Error(`'${href}' is expected to be a valid local path`);
  }
  return './' + name;
}

const plugin: Plugin<[PluginOption], Root> = ({ isValidLocalLink }) => {
  return (tree) => {
    visit(tree, 'element', (node) => {
      if (node.tagName != 'a') return;
      let href = node.properties?.href;
      if (typeof href !== 'string') return;
      if (href.startsWith('#')) return;

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
