// Pure logic for the NPI bulk exporter: query planning, segment splitting and row flattening.
// Network access is injected (fetchPage) so everything here is unit-testable offline.

export const API_URL = 'https://npiregistry.cms.hhs.gov/api/';
export const PAGE_SIZE = 200; // API maximum for `limit`
export const MAX_SKIP = 1000; // API maximum for `skip`, so one query can return at most 1,200 rows

/** Map actor input to NPPES API query parameters (without paging). */
export function baseParamsFromInput(input = {}) {
    const p = {};
    const set = (key, value) => {
        if (value === undefined || value === null) return;
        const v = String(value).trim();
        if (v) p[key] = v;
    };
    set('taxonomy_description', input.taxonomy);
    set('enumeration_type', input.enumerationType);
    set('first_name', input.firstName);
    set('last_name', input.lastName);
    set('organization_name', input.organizationName);
    set('city', input.city);
    set('postal_code', input.postalCode);
    set('address_purpose', input.addressPurpose);
    return p;
}

/** One starting segment per requested state (or a single segment when no state is given). */
export function initialSegments(input = {}) {
    const base = baseParamsFromInput(input);
    const states = (input.states || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
    if (!states.length) return [base];
    return [...new Set(states)].map((state) => ({ ...base, state }));
}

export function buildUrl(params, skip = 0, limit = PAGE_SIZE) {
    const q = new URLSearchParams({ version: '2.1', ...params, limit: String(limit), skip: String(skip) });
    return `${API_URL}?${q.toString()}`;
}

/**
 * Split a segment that has more rows than one query can return.
 * Order: ZIP prefix 2 -> 3 -> 4 digits (wildcards) -> exact 5-digit ZIP -> entity type.
 * Returns [] when the segment cannot be split further.
 */
export function splitSegment(params) {
    const digits = Array.from({ length: 10 }, (_, i) => String(i));
    const zip = params.postal_code;
    if (!zip) {
        return Array.from({ length: 100 }, (_, i) => ({ ...params, postal_code: `${String(i).padStart(2, '0')}*` }));
    }
    const m = /^(\d{2,4})\*$/.exec(zip);
    if (m) {
        const prefix = m[1];
        const suffix = prefix.length === 4 ? '' : '*';
        return digits.map((d) => ({ ...params, postal_code: `${prefix}${d}${suffix}` }));
    }
    if (!params.enumeration_type) {
        return ['NPI-1', 'NPI-2'].map((t) => ({ ...params, enumeration_type: t }));
    }
    return [];
}

export function isNeedsMoreCriteriaError(errors) {
    return (errors || []).some((e) => /additional search criteria/i.test(e.description || ''));
}

function formatZip(zip) {
    if (!zip) return '';
    const z = String(zip);
    return z.length === 9 ? `${z.slice(0, 5)}-${z.slice(5)}` : z;
}

function joinName(...parts) {
    return parts.filter((x) => x && String(x).trim()).join(' ');
}

function addressFields(prefix, a) {
    return {
        [`${prefix}Address1`]: a?.address_1 || '',
        [`${prefix}Address2`]: a?.address_2 || '',
        [`${prefix}City`]: a?.city || '',
        [`${prefix}State`]: a?.state || '',
        [`${prefix}Zip`]: formatZip(a?.postal_code),
        [`${prefix}Country`]: a?.country_code || '',
        [`${prefix}Phone`]: a?.telephone_number || '',
        [`${prefix}Fax`]: a?.fax_number || '',
    };
}

/** Flatten one NPPES API result into a spreadsheet-friendly row. */
export function flattenProvider(r, { includeRaw = false } = {}) {
    const b = r.basic || {};
    const isOrg = r.enumeration_type === 'NPI-2';
    const addresses = r.addresses || [];
    const location = addresses.find((a) => a.address_purpose === 'LOCATION');
    const mailing = addresses.find((a) => a.address_purpose === 'MAILING');
    const taxonomies = r.taxonomies || [];
    const primary = taxonomies.find((t) => t.primary) || taxonomies[0] || {};
    const row = {
        npi: String(r.number),
        entityType: isOrg ? 'Organization' : 'Individual',
        name: isOrg ? b.organization_name || '' : joinName(b.name_prefix, b.first_name, b.middle_name, b.last_name, b.name_suffix),
        firstName: b.first_name || '',
        middleName: b.middle_name || '',
        lastName: b.last_name || '',
        credential: b.credential || '',
        gender: b.sex || b.gender || '',
        soleProprietor: b.sole_proprietor || '',
        organizationName: b.organization_name || '',
        authorizedOfficialName: joinName(b.authorized_official_first_name, b.authorized_official_middle_name, b.authorized_official_last_name),
        authorizedOfficialTitle: b.authorized_official_title_or_position || '',
        authorizedOfficialPhone: b.authorized_official_telephone_number || '',
        status: b.status === 'A' ? 'Active' : b.status || '',
        enumerationDate: b.enumeration_date || '',
        lastUpdated: b.last_updated || '',
        primaryTaxonomyCode: primary.code || '',
        primaryTaxonomy: primary.desc || '',
        primaryLicense: primary.license || '',
        primaryLicenseState: primary.state || '',
        allTaxonomies: taxonomies.map((t) => `${t.code} ${t.desc}`.trim()).join('; '),
        ...addressFields('practice', location),
        ...addressFields('mailing', mailing),
        otherPracticeLocations: (r.practiceLocations || []).length,
        registryUrl: `https://npiregistry.cms.hhs.gov/provider-view/${r.number}`,
    };
    if (includeRaw) row.raw = r;
    return row;
}

/**
 * Harvest every provider matching the segments, splitting any segment that exceeds the
 * 1,200-row query cap. `fetchPage(params, skip)` resolves to the parsed API JSON.
 * `onRows(rows)` receives new, de-duplicated raw results and returns false to stop.
 */
export async function harvest(segments, fetchPage, onRows, { concurrency = 4, log = () => {} } = {}) {
    const queue = [...segments];
    const seen = new Set();
    const stats = { requests: 0, segments: 0, splits: 0, truncatedSegments: [] };
    let stopped = false;

    const emit = async (results) => {
        const fresh = [];
        for (const r of results || []) {
            const id = String(r.number);
            if (seen.has(id)) continue;
            seen.add(id);
            fresh.push(r);
        }
        if (fresh.length && !stopped && (await onRows(fresh)) === false) stopped = true;
    };

    const get = async (params, skip) => {
        stats.requests++;
        return fetchPage(params, skip);
    };

    const processSegment = async (params) => {
        stats.segments++;
        // Probe the last reachable page first: a full page there means the segment overflows.
        const probe = await get(params, MAX_SKIP);
        const overflow = isNeedsMoreCriteriaError(probe.Errors) || (probe.results || []).length >= PAGE_SIZE;
        if (probe.Errors && !overflow) {
            throw new Error(`NPPES API error: ${probe.Errors.map((e) => e.description).join('; ')}`);
        }
        if (overflow) {
            const children = splitSegment(params);
            if (children.length) {
                stats.splits++;
                queue.push(...children);
                return;
            }
            stats.truncatedSegments.push(params);
            log(`Segment still over 1,200 rows and cannot be split further; keeping the first 1,200: ${JSON.stringify(params)}`);
        }
        for (let skip = 0; skip < MAX_SKIP && !stopped; skip += PAGE_SIZE) {
            const page = await get(params, skip);
            if (page.Errors) throw new Error(`NPPES API error: ${page.Errors.map((e) => e.description).join('; ')}`);
            const results = page.results || [];
            await emit(results);
            if (results.length < PAGE_SIZE) return; // last page reached before the probe offset
        }
        if (!stopped) await emit(probe.results);
    };

    const worker = async () => {
        while (queue.length && !stopped) {
            await processSegment(queue.shift());
        }
    };
    // Workers exit when the queue is momentarily empty, so loop until splits stop adding work.
    while (queue.length && !stopped) {
        await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    }
    stats.unique = seen.size;
    return stats;
}
