import type { SupplierName, SupplierOffer } from '../domain/hotels';

export const supplierData: Record<SupplierName, readonly SupplierOffer[]> = {
  'Supplier A': [
    { hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi', commissionPct: 10 },
    { hotelId: 'a2', name: 'Radison', price: 5900, city: 'delhi', commissionPct: 13 },
    { hotelId: 'a3', name: 'The Imperial', price: 12500, city: 'delhi', commissionPct: 12 },
    { hotelId: 'a4', name: 'City Garden', price: 4500, city: 'delhi', commissionPct: 11 },
    { hotelId: 'a5', name: 'Sea Pearl', price: 7200, city: 'mumbai', commissionPct: 14 },
    { hotelId: 'a6', name: 'Harbour View', price: 9400, city: 'mumbai', commissionPct: 12 }
  ],
  'Supplier B': [
    { hotelId: 'b1', name: 'Holtin', price: 5340, city: 'delhi', commissionPct: 20 },
    { hotelId: 'b2', name: 'Radison', price: 6200, city: 'delhi', commissionPct: 18 },
    { hotelId: 'b3', name: ' city garden ', price: 4500, city: 'delhi', commissionPct: 19 },
    { hotelId: 'b4', name: 'Lotus Residency', price: 3800, city: 'delhi', commissionPct: 15 },
    { hotelId: 'b5', name: 'Sea Pearl', price: 6900, city: 'mumbai', commissionPct: 17 },
    { hotelId: 'b6', name: 'Marine Suites', price: 8100, city: 'mumbai', commissionPct: 16 }
  ]
};
