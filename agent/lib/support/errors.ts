/** A model-correctable choice: retain the lease and return the reason without posting. */
export class SupportRefusal extends Error {
  override name = "SupportRefusal";
}

/** An expired or disabled run must stop, without claiming an infrastructure outage. */
export class SupportLeaseLost extends SupportRefusal {
  override name = "SupportLeaseLost";
}

export class SupportStateConflict extends SupportRefusal {
  override name = "SupportStateConflict";
}
