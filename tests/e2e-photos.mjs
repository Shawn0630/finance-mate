// photos: Property photo gallery (uploads, legacy URL) — split from tests/e2e.mjs (Phase 1: harness-only split).
// Run standalone: node tests/e2e-photos.mjs  (deps run first, in setup mode)
// Run via the suite runner: node tests/e2e-run.mjs [--only photos]
import { runModuleMain } from './e2e-child.mjs';
export const deps = [];
export async function run(H, S) {
  let r;
  // Uploads land in property_photos (files under data/photos); the
  // detail response carries the ordered gallery; a legacy external
  // photo_url rides along as one extra entry until removed.
  const GALLERY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  r = await H.req('GET', '/api/properties');
  const legacyProp = (r.data || []).find((p) => p.address === '1 Legacy Lane');
  H.check('legacy single photo_file migrated into the gallery',
    !!legacyProp && Array.isArray(legacyProp.photos) && legacyProp.photos.length === 1
      && legacyProp.photos[0].kind === 'upload' && legacyProp.photos[0].src === '/photos/legacy-photo.jpg'
      && legacyProp.photo_file === null,
    JSON.stringify(legacyProp && legacyProp.photos));
  r = await H.req('POST', '/api/properties', {
    address: '77 Gallery Grove, Victoria, BC', mortgage_balance: 100000, purchase_date: '2021-05-01',
  });
  H.check('gallery fixture property created', r.status === 201, JSON.stringify(r.status));
  const galId = r.data.id;
  r = await H.req('GET', `/api/properties/${galId}`);
  H.check('a new property starts with an empty gallery',
    Array.isArray(r.data.photos) && r.data.photos.length === 0, JSON.stringify(r.data.photos));
  r = await H.req('POST', `/api/properties/${galId}/photos`, {
    images: [
      { dataBase64: GALLERY_PNG, contentType: 'image/png' },
      { dataBase64: GALLERY_PNG, contentType: 'image/png' },
    ],
  });
  H.check('batch upload appends two photos in order',
    r.status === 200 && r.data.photos.length === 2
      && r.data.photos.every((x) => x.kind === 'upload' && x.src.startsWith('/photos/'))
      && r.data.photos[0].id !== r.data.photos[1].id,
    JSON.stringify(r.data.photos));
  const firstPhoto = r.data.photos[0];
  const served = await fetch(H.BASE + firstPhoto.src, { headers: { Cookie: H.getCookie() } });
  H.check('an uploaded photo file is served back', served.status === 200, String(served.status));
  r = await H.req('POST', `/api/properties/${galId}/photos`, { dataBase64: GALLERY_PNG, contentType: 'image/png' });
  H.check('single-image upload shape also works', r.status === 200 && r.data.photos.length === 3,
    JSON.stringify(r.data.photos && r.data.photos.length));
  const badBatch = await H.req('POST', `/api/properties/${galId}/photos`, {
    images: [
      { dataBase64: GALLERY_PNG, contentType: 'image/png' },
      { dataBase64: 'aGVsbG8=', contentType: 'text/plain' },
    ],
  });
  H.check('a batch with a non-image is rejected whole', badBatch.status === 400, JSON.stringify(badBatch.data));
  r = await H.req('GET', `/api/properties/${galId}`);
  H.check('the rejected batch wrote nothing', r.data.photos.length === 3, JSON.stringify(r.data.photos.length));
  // Legacy external URL: set like the old form used to, shows as an
  // extra gallery entry, and removing it clears the field for good.
  r = await H.req('PUT', `/api/properties/${galId}`, { photo_url: 'https://example.com/house.jpg' });
  H.check('legacy photo_url joins the gallery as a url entry',
    r.status === 200 && r.data.photos.length === 4
      && r.data.photos[3].kind === 'url' && r.data.photos[3].id === 'url'
      && r.data.photos[3].src === 'https://example.com/house.jpg',
    JSON.stringify(r.data.photos));
  r = await H.req('DELETE', `/api/properties/${galId}/photos/url`);
  H.check('removing the url entry clears photo_url',
    r.status === 200 && r.data.photo_url === null && r.data.photos.length === 3,
    JSON.stringify(r.data.photos && r.data.photos.length));
  r = await H.req('DELETE', `/api/properties/${galId}/photos/${firstPhoto.id}`);
  H.check('deleting one upload leaves the rest in order',
    r.status === 200 && r.data.photos.length === 2 && !r.data.photos.some((x) => x.id === firstPhoto.id),
    JSON.stringify(r.data.photos));
  const gone = await fetch(H.BASE + firstPhoto.src, { headers: { Cookie: H.getCookie() } });
  H.check('the deleted photo file is gone', gone.status === 404, String(gone.status));
  r = await H.req('DELETE', `/api/properties/${galId}/photos/99999`);
  H.check('deleting a missing photo is 404', r.status === 404);

  // ---- Money inputs: grouped on screen, plain numbers on the wire ----
}

runModuleMain(import.meta.url, { name: 'photos', deps, depNames: [], run });
