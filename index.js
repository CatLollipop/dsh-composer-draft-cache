/**
 * Host half of the composer draft cache bundle.
 *
 * The whole feature is browser state: the Client module registers a headless
 * entry that mirrors each Workspace's unsent new-session draft and restores it
 * when a fresh blank Session opens in the same Workspace. Nothing is sent to
 * the Host, so this half only keeps the bundle's plugin row active.
 */
export function apply() {}
