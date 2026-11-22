import { describe, expect, it } from 'vitest';
import { aggregateOffers } from '../../src/domain/hotels';
import type { SupplierBatch, SupplierName, SupplierOffer } from '../../src/domain/hotels';

const offer = (overrides: Partial<SupplierOffer> = {}): SupplierOffer => ({
  hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi', commissionPct: 10, ...overrides
});
const batch = (supplier: SupplierName, ...offers: SupplierOffer[]): SupplierBatch => ({ supplier, offers });

describe('hotel aggregation', () => {
  it.each([
    [5000, 6000, 'Supplier A', 10],
    [6000, 5340, 'Supplier B', 20],
    [6000, 6000, 'Supplier A', 10]
  ] as const)('selects the correct offer for prices %s and %s', (a, b, supplier, commissionPct) => {
    expect(aggregateOffers([batch('Supplier A', offer({ price: a })), batch('Supplier B', offer({ price: b, commissionPct: 20 }))]))
      .toEqual([{ name: 'Holtin', price: Math.min(a, b), supplier, commissionPct }]);
  });

  it('preserves hotels exclusive to either supplier', () => {
    const result = aggregateOffers([batch('Supplier A', offer({ name: 'Imperial' })), batch('Supplier B', offer({ name: 'Lotus', price: 4000 }))]);
    expect(result.map(value => value.name)).toEqual(['Lotus', 'Imperial']);
  });

  it('handles empty suppliers', () => expect(aggregateOffers([batch('Supplier A'), batch('Supplier B')])).toEqual([]));
  it('handles no batches', () => expect(aggregateOffers([])).toEqual([]));

  it('normalizes case and trims boundaries while preserving the winning display name', () => {
    expect(aggregateOffers([batch('Supplier A', offer({ name: '  HOLTIN ' })), batch('Supplier B', offer({ name: ' Holtin ', price: 5340 }))]))
      .toEqual([{ name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 10 }]);
  });

  it('deduplicates repeated offers from the same supplier', () => {
    expect(aggregateOffers([batch('Supplier A', offer(), offer({ price: 5900 }), offer({ price: 6100 }))])).toHaveLength(1);
    expect(aggregateOffers([batch('Supplier A', offer(), offer({ price: 5900 }))])[0]?.price).toBe(5900);
  });

  it('does not fuzzy-match unrelated names', () => {
    expect(aggregateOffers([batch('Supplier A', offer({ name: 'Sea View' }), offer({ name: 'SeaView' }), offer({ name: 'Sea  View' }))])).toHaveLength(3);
  });

  it('sorts by price then normalized name deterministically', () => {
    const a = batch('Supplier A', offer({ name: 'Zoo', price: 4000 }), offer({ name: 'Alpha', price: 4000 }), offer({ name: 'Beta', price: 1000 }));
    expect(aggregateOffers([a]).map(value => value.name)).toEqual(['Beta', 'Alpha', 'Zoo']);
  });

  it('chooses price before commission', () => {
    expect(aggregateOffers([batch('Supplier A', offer({ price: 10, commissionPct: 1 })), batch('Supplier B', offer({ price: 11, commissionPct: 99 }))])[0]?.supplier).toBe('Supplier A');
  });

  it('is independent of supplier and offer ordering, including same-supplier ties', () => {
    const a = batch('Supplier A', offer({ name: 'holtin' }), offer({ name: 'Holtin', commissionPct: 8 }), offer());
    const b = batch('Supplier B', offer());
    expect(aggregateOffers([a, b])).toEqual(aggregateOffers([b, { ...a, offers: [...a.offers].reverse() }]));
  });

  it.each([NaN, Infinity, -1])('ignores invalid price %s', price => {
    expect(aggregateOffers([batch('Supplier A', offer({ price }))])).toEqual([]);
  });

  it('does not mutate inputs', () => {
    const input = [batch('Supplier A', offer({ name: ' Holtin ' }))];
    const copy = structuredClone(input);
    aggregateOffers(input);
    expect(input).toEqual(copy);
  });
});
