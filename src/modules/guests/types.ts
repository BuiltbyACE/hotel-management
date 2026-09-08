/**
 * modules/guests/types.ts
 *
 * Public view types for guest profiles and documents. Money fields (numeric)
 * are surfaced as JavaScript numbers; dates as ISO strings.
 */
export type IdDocumentType = 'national_id' | 'passport' | 'driving_licence' | 'military' | 'other';

export interface GuestView {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  idType: IdDocumentType | null;
  idNumber: string | null;
  nationality: string | null;
  dateOfBirth: string | null;
  address: string | null;
  company: string | null;
  notes: string | null;
  isBlacklisted: boolean;
  blacklistReason: string | null;
  stayCount: number;
  lifetimeValue: number;
  lastStayDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GuestDocumentView {
  id: string;
  guestId: string;
  fileId: string;
  docType: IdDocumentType;
  uploadedBy: string | null;
  createdAt: string;
}