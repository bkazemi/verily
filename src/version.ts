/**
 * The release a build is, shown beside the logotype so a reader can say which version drew
 * what they are looking at. In full: before a first major release the major alone says
 * nothing, and text is read on a phone where a hover is not.
 *
 * Held in step with package.json by a test rather than by a build step, so the published
 * output stays what tsc emitted and nothing has to be substituted into it. A version bump
 * changes this line with package.json.
 */
export const version = 'v0.0.12';
