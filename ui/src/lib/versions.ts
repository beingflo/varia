/** A version id as history shows it: stable across devices, because it is the id the writer minted. */
export const shortId = (id: string): string => id.replace(/-/g, '').slice(0, 7);
