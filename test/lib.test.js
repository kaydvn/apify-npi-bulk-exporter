import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseParamsFromInput, buildUrl, flattenProvider, harvest, initialSegments, splitSegment } from '../src/lib.js';

const sample = {
    addresses: [
        { address_1: '200 TOLL GATE RD STE 102', address_purpose: 'MAILING', city: 'WARWICK', country_code: 'US', postal_code: '028864440', state: 'RI', telephone_number: '719-966-9147' },
        { address_1: '200 TOLL GATE RD STE 104', address_purpose: 'LOCATION', city: 'WARWICK', country_code: 'US', postal_code: '028864487', state: 'RI', telephone_number: '401-737-9363' },
    ],
    basic: { authorized_official_first_name: 'AHMED', authorized_official_last_name: 'ABDELAAL', authorized_official_middle_name: 'TAREK', authorized_official_title_or_position: 'owner', enumeration_date: '2025-12-15', last_updated: '2026-08-05', organization_name: 'A T DENTAL LLC', status: 'A' },
    enumeration_type: 'NPI-2',
    number: '1861356743',
    practiceLocations: [{ address_1: '424 STATE RD', state: 'MA' }],
    taxonomies: [{ code: '122300000X', desc: 'Dentist', license: null, primary: true, state: null }],
};

test('flattenProvider maps an organization record', () => {
    const row = flattenProvider(sample);
    assert.equal(row.npi, '1861356743');
    assert.equal(row.entityType, 'Organization');
    assert.equal(row.name, 'A T DENTAL LLC');
    assert.equal(row.authorizedOfficialName, 'AHMED TAREK ABDELAAL');
    assert.equal(row.practiceAddress1, '200 TOLL GATE RD STE 104');
    assert.equal(row.practiceZip, '02886-4487');
    assert.equal(row.mailingPhone, '719-966-9147');
    assert.equal(row.primaryTaxonomy, 'Dentist');
    assert.equal(row.status, 'Active');
    assert.equal(row.otherPracticeLocations, 1);
    assert.equal(row.raw, undefined);
    assert.ok(flattenProvider(sample, { includeRaw: true }).raw);
});

test('flattenProvider maps an individual and tolerates missing parts', () => {
    const row = flattenProvider({ number: 1234567890, enumeration_type: 'NPI-1', basic: { first_name: 'JANE', last_name: 'DOE', credential: 'DDS' } });
    assert.equal(row.name, 'JANE DOE');
    assert.equal(row.entityType, 'Individual');
    assert.equal(row.practiceCity, '');
    assert.equal(row.primaryTaxonomyCode, '');
});

test('input mapping and segments', () => {
    assert.deepEqual(baseParamsFromInput({ taxonomy: ' Dentist ', city: '', enumerationType: 'NPI-1' }), { taxonomy_description: 'Dentist', enumeration_type: 'NPI-1' });
    assert.deepEqual(initialSegments({ taxonomy: 'Dentist', states: ['ri', 'RI', 'ca'] }), [
        { taxonomy_description: 'Dentist', state: 'RI' },
        { taxonomy_description: 'Dentist', state: 'CA' },
    ]);
    const url = buildUrl({ state: 'RI', postal_code: '028*' }, 400);
    assert.match(url, /version=2\.1/);
    assert.match(url, /postal_code=028\*/);
    assert.match(url, /limit=200&skip=400/);
});

test('splitSegment walks ZIP prefixes then entity type', () => {
    assert.equal(splitSegment({ state: 'CA' }).length, 100);
    assert.equal(splitSegment({ state: 'CA' })[7].postal_code, '07*');
    assert.deepEqual(splitSegment({ postal_code: '90*' }).map((s) => s.postal_code).slice(0, 2), ['900*', '901*']);
    assert.equal(splitSegment({ postal_code: '9021*' })[0].postal_code, '90210');
    assert.deepEqual(splitSegment({ postal_code: '90210' }).map((s) => s.enumeration_type), ['NPI-1', 'NPI-2']);
    assert.deepEqual(splitSegment({ postal_code: '90210', enumeration_type: 'NPI-1' }), []);
});

// Fake registry: `count` providers per ZIP code, matched by trailing-wildcard prefixes.
function fakeRegistry(zips) {
    const all = [];
    let n = 1000000000;
    for (const [zip, count] of Object.entries(zips)) {
        for (let i = 0; i < count; i++) all.push({ number: String(n++), enumeration_type: i % 2 ? 'NPI-2' : 'NPI-1', addresses: [{ address_purpose: 'LOCATION', postal_code: `${zip}0000` }] });
    }
    return async (params, skip) => {
        if (!params.postal_code && params.state && !params.taxonomy_description) {
            return { Errors: [{ description: 'Field state requires additional search criteria' }] };
        }
        let rows = all;
        if (params.postal_code) {
            const pc = params.postal_code;
            rows = rows.filter((r) => (pc.endsWith('*') ? r.addresses[0].postal_code.startsWith(pc.slice(0, -1)) : r.addresses[0].postal_code.startsWith(pc)));
        }
        if (params.enumeration_type) rows = rows.filter((r) => r.enumeration_type === params.enumeration_type);
        return { result_count: 0, results: rows.slice(skip, skip + 200) };
    };
}

test('harvest returns everything past the 1,200 cap by splitting', async () => {
    const fetchPage = fakeRegistry({ '02886': 900, '02887': 700, '10001': 50, '90210': 2000 });
    const got = [];
    const stats = await harvest([{ taxonomy_description: 'Dentist' }], fetchPage, async (rows) => { got.push(...rows); });
    assert.equal(got.length, 3650);
    assert.equal(new Set(got.map((r) => r.number)).size, 3650);
    assert.equal(stats.truncatedSegments.length, 0);
});

test('harvest splits a state-only query that the API rejects', async () => {
    const got = [];
    await harvest([{ state: 'RI' }], fakeRegistry({ '02886': 10 }), async (rows) => { got.push(...rows); });
    assert.equal(got.length, 10);
});

test('harvest stops when the consumer returns false', async () => {
    const got = [];
    const stats = await harvest([{ taxonomy_description: 'x' }], fakeRegistry({ '02886': 900 }), async (rows) => { got.push(...rows); return false; });
    assert.equal(got.length, 200);
    assert.ok(stats.requests <= 3);
});

test('harvest keeps first 1,200 of an unsplittable segment and reports it', async () => {
    const got = [];
    const stats = await harvest([{ postal_code: '90210', enumeration_type: 'NPI-1' }], fakeRegistry({ '90210': 3000 }), async (rows) => { got.push(...rows); });
    assert.equal(got.length, 1200);
    assert.equal(stats.truncatedSegments.length, 1);
});

test('harvest surfaces other API errors', async () => {
    await assert.rejects(harvest([{ city: 'x' }], async () => ({ Errors: [{ description: 'Invalid city' }] }), async () => {}), /Invalid city/);
});
