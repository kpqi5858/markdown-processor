import { Static, Type } from '@sinclair/typebox';

const FrontMatterRequired = Type.Object({
  title: Type.String(),
  /**
   * Write like 2022-09-30 04:18
   *
   * It will be stored as ISO 8601 date format after processed.
   */
  writtenDate: Type.String(),
});

const FrontMatterOptional = Type.Partial(Type.Object({
  /**
   * If set to true, it will not be included in processed.
   */
   noPublish: Type.Boolean(),
   /**
    * If not set, it will grab from first sections of markdown content.
    */
   description: Type.String(),
   category: Type.Array(Type.String())
}));

type GeneratedMetadataType = {
  description: string
};

export const FrontMatterYaml = Type.Intersect([FrontMatterRequired, FrontMatterOptional], { additionalProperties: false });
export type FrontMatterYamlType = Static<typeof FrontMatterYaml>;

type FrontMatterMetadataType = Omit<FrontMatterYamlType & GeneratedMetadataType, 'noPublish'>

/**
 * The type of each processed markdown json.
 */
export type ContentType = {
  id: string,
  name: string,
  metadata: FrontMatterMetadataType,
  content: string
}

/**
 * The type of generated posts.json output.
 */
export type PostsListType = Omit<ContentType, 'content'>[];
