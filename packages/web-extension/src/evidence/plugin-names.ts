/**
 * rrweb plugin-event names shared between the content-script plugins that
 * emit them (content/plugins/*.ts, main world) and the background script
 * that recognizes them in the incoming event stream (background/*.ts) -
 * factored out into their own dependency-free module so the background
 * bundle never has to import the DOM-dependent plugin implementations
 * just to compare a string.
 */
export const INTERACTION_PLUGIN_NAME = 'evidence/interaction@1';
export const STORAGE_PLUGIN_NAME = 'evidence/storage@1';
