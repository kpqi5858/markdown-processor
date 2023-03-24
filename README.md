# markdown-processor

Used for my personal site. I don't really encourage you to use this for your production but you might be interested in.

# Usage

`node dist/index.js [--posts "posts"] <inDir> <outDir>`

- `<inDir>` Where your markdown files in.
- `<outDir>` Where to put processed markdowns.
- `--posts` File name of posts collection.

markdown-processor will search for markdowns in `<inDir>` recursively, and process them to json files with collection of posts without content.

Markdown should have front-matter in yaml format. Available fields are:

- `title` (String, Required): The title of this markdown post.
- `writtenDate` (String, Required): When this markdown post had written.
- `subtitle` (String): Subtitle of this post.
- `description` (String): Short description of this post. If not set, the first 100 characters from markdown post will be used.
- `category` (String[]): Categories of this post.
- `noPublish` (Boolean): If set to true, this post will not be processed.
- `unlisted` (Boolean): If set to true, this post will not be included in posts list.

`noPublish` and `unlisted` will be stripped in the processing.
