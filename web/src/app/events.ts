/** Window event asking the query bar to focus the filter editor. */
export const FOCUS_FILTER = 'ldaplens:focus-filter'

/** Window event asking the query bar to run its search, as the Run button does. */
export const RUN_SEARCH = 'ldaplens:run-search'

/** Window event asking the query bar to format its text filter. */
export const FORMAT_FILTER = 'ldaplens:format-filter'

/** Window event asking the workspace to open the review dialog. */
export const OPEN_REVIEW = 'ldaplens:open-review'

/**
 * Window event, a CustomEvent whose detail is an EntryActionKind, asking the workspace to open
 * that action's dialog for the open entry.
 */
export const ENTRY_ACTION = 'ldaplens:entry-action'

/** Window event asking the inspector to turn on Edit and open its "Add to group" field. */
export const ADD_TO_GROUP = 'ldaplens:add-to-group'
