# markdown-processor

Used for my personal site. I don't really encourage you to use this for your production but you might be interested in.

# Usage

`node dist/index.js [options] <inDir> <outDir>`

- `<inDir>` Where your markdown files in.
- `<outDir>` Where to put processed markdowns.
- `--posts` File name of posts collection. Default is "posts"
- `--metadata` Optionally specify metadata.
- `-f, --force` Process all markdowns freshly.

markdown-processor will search for markdowns in `<inDir>` recursively, and process them to json files, with collection of posts that doesn't contain contents.

Markdown should have front-matter in yaml format. Available fields are:

- `title` (String, Required): The title of this markdown post.
- `writtenDate` (String, Required): When this markdown post had written.
- `subtitle` (String): Subtitle of this post.
- `series` (String): Series of this post.
- `description` (String): Short description of this post. If not set, the first 100 characters from markdown post will be used.
- `category` (String[]): Categories of this post.
- `draft` (Boolean): If set to true, this post will not be processed.
- `unlisted` (Boolean): If set to true, this post will not be included in posts list.

`draft` and `unlisted` will be stripped after processing.
