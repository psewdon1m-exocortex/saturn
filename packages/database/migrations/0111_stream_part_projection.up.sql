-- Repair the v2 ACK projection without changing originals or receipts.
-- #variable_conflict use_variable made the inner unqualified chunk reference
-- resolve to the command payload variable (NULL for status/seal).
LOCK TABLE public.sync_backend_executor IN SHARE ROW EXCLUSIVE MODE;
DO $repair$
DECLARE definition text; needle text; replacement text;
BEGIN
 IF EXISTS(SELECT 1 FROM public.sync_backend_executor WHERE state<>'STOPPED') THEN
   RAISE EXCEPTION 'backend must be stopped before stream projection migration';
 END IF;
 definition:=pg_get_functiondef('public.sync_stream_command(text,jsonb,jsonb,jsonb)'::regprocedure);
 needle:='FROM (SELECT part_index,chunk FROM public.sync_stream_parts WHERE operation_id=s.operation_id AND state=''ACKED'' AND part_index>page_after ORDER BY part_index LIMIT 256) p;';
 replacement:='FROM (SELECT stream_part_row.part_index,stream_part_row.chunk FROM public.sync_stream_parts AS stream_part_row WHERE stream_part_row.operation_id=s.operation_id AND stream_part_row.state=''ACKED'' AND stream_part_row.part_index>page_after ORDER BY stream_part_row.part_index LIMIT 256) p;';
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
   RAISE EXCEPTION 'stream projection predecessor changed';
 END IF;
 INSERT INTO public.sync_extension_function_backup(revision,identity,definition)
 VALUES(111,'sync_stream_command(text,jsonb,jsonb,jsonb)',definition);
 EXECUTE replace(definition,needle,replacement);
END $repair$;
