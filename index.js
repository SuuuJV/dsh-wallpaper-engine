/**
 * Host half.
 *
 * All the work happens in the browser half: the user grants access to their
 * Wallpaper Engine folder through the file picker, and the client reads
 * project.json / preview images / scene.pkg directly. Nothing here needs the
 * host filesystem, so this stays an empty Loader seat.
 */
export function apply() {}
