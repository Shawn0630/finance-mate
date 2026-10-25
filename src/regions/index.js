// Region registry. Region-specific logic (mortgage interest
// conventions, the prime-rate source, the assessment provider) is
// implemented per region behind this one lookup, so adding a region
// means adding one module here — the engine and the API only ever
// talk to this interface. Only Canada is implemented for now.
import * as ca from './ca.js';

const REGIONS = { CA: ca };

export const REGION_CODES = Object.keys(REGIONS);
export const DEFAULT_REGION = 'CA';

export function getRegion(code) {
  return REGIONS[String(code || DEFAULT_REGION).toUpperCase()] || null;
}
