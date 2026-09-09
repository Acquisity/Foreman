-- A provider receipt may arrive after its case lease expires. Only its reserving run can record it.
ALTER TABLE support_operations ADD COLUMN reservation_lease uuid;
