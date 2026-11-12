-- A full expression index supplies due-time statistics for idle polling as well as lookup.
CREATE INDEX idx_report_intakes_reporter_presentation_due
  ON report_intakes ((metadata->'reporter_presentation'->>'nextDueAt'), id);

ANALYZE report_intakes;
