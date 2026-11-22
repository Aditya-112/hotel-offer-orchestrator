import { z } from 'zod';

export const supplierNames = ['Supplier A', 'Supplier B'] as const;
export type SupplierName = (typeof supplierNames)[number];

export const supplierOfferSchema = z.object({
  hotelId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(200),
  price: z.number().nonnegative(),
  city: z.string().trim().min(1),
  commissionPct: z.number().min(0).max(100)
});

export const hotelOfferSchema = supplierOfferSchema.pick({ name: true, price: true, commissionPct: true })
  .extend({ supplier: z.enum(supplierNames) }).strict();

export type SupplierOffer = z.infer<typeof supplierOfferSchema>;
export type HotelOffer = z.infer<typeof hotelOfferSchema>;
export type SupplierBatch = { supplier: SupplierName; offers: SupplierOffer[] };
export type SupplierFailure = { supplier: SupplierName; reason: 'timeout' | 'unavailable' };
export type AggregationResult = { offers: HotelOffer[]; failures: SupplierFailure[] };
export type PriceRange = { minPrice?: number; maxPrice?: number };
export type HotelQuery = PriceRange & { city: string };

export function normalizeHotelName(name: string): string {
  return name.trim().toLowerCase();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareOffers(left: HotelOffer, right: HotelOffer): number {
  return left.price - right.price || compareText(normalizeHotelName(left.name), normalizeHotelName(right.name));
}

export function aggregateOffers(batches: SupplierBatch[]): HotelOffer[] {
  const winners = new Map<string, HotelOffer>();
  for (const batch of batches) {
    for (const offer of batch.offers) {
      if (!supplierOfferSchema.safeParse(offer).success) continue;
      const candidate: HotelOffer = {
        name: offer.name.trim(), price: offer.price,
        supplier: batch.supplier, commissionPct: offer.commissionPct
      };
      const key = normalizeHotelName(candidate.name);
      const current = winners.get(key);
      const order = current
        ? candidate.price - current.price || compareText(candidate.supplier, current.supplier)
          || compareText(candidate.name, current.name) || candidate.commissionPct - current.commissionPct
        : -1;
      if (order < 0) winners.set(key, candidate);
    }
  }
  return [...winners.values()].sort(compareOffers);
}
