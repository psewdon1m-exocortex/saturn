-- Add an aggregate entry point to the same qualified SECURITY DEFINER identity.
-- Each original has its own exception subtransaction and individual result.
INSERT INTO sync_extension_function_backup VALUES(73,'catalog_upload_command(text,jsonb,jsonb,jsonb)',pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure));
DO $install$
DECLARE definition text; marker text; replacement text;
BEGIN
 definition:=pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure);
 marker:='DECLARE g public.catalog_guard_roots%ROWTYPE;';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'upload batch declaration mismatch'; END IF;
 definition:=replace(definition,marker,'DECLARE batch_item jsonb; batch_values jsonb := ''[]''::jsonb; batch_value jsonb; g public.catalog_guard_roots%ROWTYPE;');
 marker:=' IF (SELECT namespace_row.nspname';
 replacement:=$body$
 IF command='batch' THEN
   IF input IS DISTINCT FROM '{}'::jsonb OR jsonb_typeof(command_payload) IS DISTINCT FROM 'array'
     OR jsonb_array_length(command_payload) NOT BETWEEN 1 AND 16 OR octet_length(command_payload::text)>2097152 THEN RAISE EXCEPTION 'invalid_input'; END IF;
   FOR batch_item IN SELECT value FROM jsonb_array_elements(command_payload) LOOP
     IF jsonb_typeof(batch_item) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(batch_item))<>3
       OR NOT batch_item ?& ARRAY['command','input','payload'] OR batch_item->>'command' NOT IN ('reserve','status','chunk','progress','verify','claim','commit','cancel','unknown') THEN RAISE EXCEPTION 'invalid_input'; END IF;
     BEGIN
       batch_value:=public.catalog_upload_command(batch_item->>'command',batch_item->'input',credential,batch_item->'payload');
       batch_values:=batch_values||jsonb_build_array(jsonb_build_object('value',batch_value));
     EXCEPTION WHEN OTHERS THEN
       -- Do not hide SQL faults/timeouts/cancellation as individual product errors.
       IF SQLERRM NOT IN ('invalid_input','binding_invalid','authorization_changed','operation_reused','membership_changed','precondition_failed','reconciliation_required','admission_full','transfer_unresolved','verification_failed','projection_mismatch','counter_exhausted','upload_too_large','invalid_name','backend_draining','capacity') THEN RAISE; END IF;
       batch_values:=batch_values||jsonb_build_array(jsonb_build_object('error',SQLERRM));
     END;
   END LOOP;
   RETURN batch_values;
 END IF;
 IF (SELECT namespace_row.nspname$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'upload batch body mismatch'; END IF;
 EXECUTE replace(definition,marker,replacement);
END $install$;
