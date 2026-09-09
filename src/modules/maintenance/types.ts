/**
 * modules/maintenance/types.ts
 *
 * Public types for the maintenance module (blueprint §14.1). Status and
 * priority unions mirror the DB enums locally — the module boundary forbids
 * importing another module's schema, and own-type enums flow from own schema.
 */
export type MaintenanceStatus = 'reported' | 'pending' | 'in_progress' | 'resolved' | 'closed';
export type MaintenancePriority = 'low' | 'medium' | 'high' | 'urgent';

export interface IssueView {
  id: string;
  reference: string;
  title: string;
  description: string;
  roomId: string | null;
  roomNumber: string | null;
  location: string | null;
  priority: MaintenancePriority;
  status: MaintenanceStatus;
  assignedTo: string | null;
  estimatedCost: string | null;
  takesRoomOffline: boolean;
  reportedBy: string;
  reportedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNotes: string | null;
  closedAt: string | null;
  actualCost: string | null;
  expenseCount: number;
  block: { id: string; startDate: string; endDate: string } | null;
  updates: IssueUpdateView[];
  createdAt: string;
}

export interface IssueUpdateView {
  id: string;
  fromStatus: MaintenanceStatus | null;
  toStatus: MaintenanceStatus;
  note: string | null;
  fileIds: string[];
  createdBy: string;
  createdAt: string;
}