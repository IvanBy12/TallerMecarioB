# S2-03 — cambios documentales pendientes de sincronización canónica

Este registro no sustituye ADR-009, el Diccionario ni el ERD. Sincronizar las fuentes canónicas antes del merge final.

## ADR-009 §10

- `tallermecario_worker` no tiene privilegios de tabla ni columna sobre `customers`, `vehicles` ni `vehicle_owners`. Las policies RLS existentes permanecen; sin grants no conceden acceso.
- `tallermecario_api` conserva `SELECT` e `INSERT` en las tres tablas y `UPDATE` solo por columna: `customers` (`document_type`, `document_number`, `first_name`, `last_name`, `phone`, `email`, `notes`, `updated_at`); `vehicles` (`plate`, `vin`, `vehicle_type`, `brand`, `model`, `model_year`, `color`, `engine_number`, `current_mileage_km`, `updated_at`); `vehicle_owners` (`valid_to`). Ningún runtime recibe `DELETE` o `TRUNCATE`; `PUBLIC` no recibe privilegios CRM.

## Diccionario §11 — vehicles

- `vehicles_plate_normalized_check`: `plate = btrim(plate) AND plate = upper(plate COLLATE "C")`. Decisión D-01a: sin espacios ASCII iniciales/finales ni letras ASCII minúsculas. La unicidad existente `(tenant_id, plate)` sigue vigente.
- `DOC_GAP-01`: charset, guiones, espacios internos, separadores, Unicode, placa vacía y reglas por `vehicle_type` siguen sin definición. No se añadió regex.

## Diccionario §12 — vehicle_owners

- Frozen-on-close: una relación vigente puede pasar `valid_to` de `NULL` a timestamp. Una fila con `OLD.valid_to IS NOT NULL` es inmutable incluso ante una escritura del mismo valor o reapertura. Los demás campos no cambian en ningún UPDATE. `vehicle_owners_validity_check` sigue comprobando `valid_to > valid_from`.

## ERD §5 y §18

- `app.enforce_vehicle_owner_history()` y `vehicle_owners_history_guard_trg` (`BEFORE UPDATE FOR EACH ROW`) protegen el historial para sesiones runtime y privilegiadas con triggers activos. La función es `SECURITY INVOKER`, owner `tallermecario_schema_owner`, `search_path=pg_catalog`, sin `EXECUTE` para `PUBLIC`.
- La migración 0018 no reescribe filas. Preflight bajo lock exclusivo y NO FORCE temporal detecta placas legacy no normalizadas y colisiones potenciales; falla con `23514 vehicles_plate_normalized_check`, sin datos de placa/VIN/IDs en el error. El runner revierte íntegramente la transacción si falla.
