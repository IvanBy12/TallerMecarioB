# RBAC — Matriz completa de roles y permisos v1

<aside>
🔐

**Objetivo:** convertir los roles base del taller en una matriz de autorización explícita, testeable y deny-by-default. Esta matriz es la fuente de verdad documental de Sprint 1 para `roles`, `permissions`, `role_permissions` y `membership_roles`.

</aside>

**Estado:** Baseline RBAC v1 — Sprint 0/Sprint 1  

**Alcance:** roles tenant del taller. No incluye privilegios internos del personal ILVOX/plataforma.  

**Relacionado:** [ADR-006 — Clerk como proveedor de identidad](ADR-006%20%E2%80%94%20Clerk%20como%20proveedor%20de%20identidad%203df6ab0a330d81ed9345c56bb7c97439.md) · [Modelo de Datos / ERD v1 — PostgreSQL](Modelo%20de%20Datos%20ERD%20v1%20%E2%80%94%20PostgreSQL%203df6ab0a330d81fda465f8944c3291e6.md) · [Quality Gates — Reglas y Pruebas por Sprint](../Metodologia%20Scrum%202%20week%20+%20Gates%20(RoadMap)/Quality%20Gates%20%E2%80%94%20Reglas%20y%20Pruebas%20por%20Sprint%203df6ab0a330d818486e9dd6f06b5f573.md)

# 1. Principios no negociables

- **Deny by default:** si un permiso no está concedido explícitamente, se rechaza.
- Autenticación ≠ autorización. Clerk identifica; PostgreSQL decide tenant, membership, roles y permisos.
- Todo permiso se evalúa server-side desde un `TenantContext` verificado.
- El frontend puede ocultar botones, pero nunca es una barrera de seguridad.
- `tenant_id`, role y permission enviados por cliente nunca otorgan autoridad.
- Los permisos efectivos son la unión de los roles activos de una membership; no habrá "deny overrides" en MVP.
- Los roles baseline son **system roles** sembrados por plataforma; el taller no crea roles custom en MVP.
- Cambios de roles/memberships invalidan permisos efectivos y generan `audit_logs`.
- Ningún permiso permite modificar directamente tablas append-only; las acciones se realizan por comandos de dominio válidos.
- RLS, FKs compuestas y RBAC son capas complementarias. RLS baseline solo decide aislamiento por tenant; los permisos owner/admin/advisor/technician y scopes A/Q siguen siendo responsabilidad del autorizador de aplicación. Ver [ADR-009 — RLS y privilegios PostgreSQL por TenantContext](ADR-009%20%E2%80%94%20RLS%20y%20privilegios%20PostgreSQL%20por%20TenantC%203e06ab0a330d8162b0cfff78ad1cb9b1.md).

# 2. Roles baseline

| Rol | Propósito | Límites principales |
| --- | --- | --- |
| `owner` | Propietario/representante del taller | Único rol con propiedad, billing contractual, aceptación legal y asignación de owner/admin. |
| `admin` | Administrador operativo | Gestiona operación y personal operativo; no puede transferir propiedad, asignar owner/admin ni cancelar/gestionar la suscripción. |
| `service_advisor` | Asesor de servicio/recepción | Opera CRM, recepción, órdenes, cotizaciones, comunicaciones, pagos del cliente y entrega; no administra seguridad, usuarios privilegiados ni configuración sensible. |
| `technician` | Técnico/mecánico | Acceso mínimo a órdenes asignadas; diagnóstico, actividades y evidencia. No ve billing, pagos, roles ni PII innecesaria. |

# 3. Leyenda de matrices

- **✅** permiso concedido para recursos del tenant.
- **A** concedido solo para recursos/órdenes asignadas a la membership.
- **Q** concedido solo si existe asignación explícita de control de calidad y se cumple la política de separación de funciones.
- **—** denegado.

# 4. Tenant, membresías y administración

| Permission code | Owner | Admin | Advisor | Technician |
| --- | --- | --- | --- | --- |
| `workshop.read` | ✅ | ✅ | ✅ | ✅ |
| `workshop.profile.update` | ✅ | ✅ | — | — |
| `workshop.legal.update` | ✅ | — | — | — |
| `locations.read` | ✅ | ✅ | ✅ | ✅ |
| `locations.manage` | ✅ | ✅ | — | — |
| `memberships.read` | ✅ | ✅ | — | — |
| `memberships.invite_staff` | ✅ | ✅ | — | — |
| `memberships.manage_staff` | ✅ | ✅ | — | — |
| `roles.assign_staff` | ✅ | ✅ | — | — |
| `roles.assign_admin` | ✅ | — | — | — |
| `roles.assign_owner` | ✅ | — | — | — |
| `ownership.transfer` | ✅ | — | — | — |
| `audit.read` | ✅ | ✅ | — | — |

`roles.assign_staff` para `admin` solo permite `service_advisor` y `technician`. No permite crear/modificar otro `admin` ni `owner`.

## Invitaciones internas

`memberships.invite_staff` no crea directamente una membership: crea una fila `membership_invitations` con tenant, email normalizado, rol objetivo, token hasheado y expiración.

Reglas RBAC:

- owner puede invitar `owner`, `admin`, `service_advisor` o `technician`, respetando las reglas de propiedad;
- admin solo puede invitar `service_advisor` o `technician`;
- advisor/technician no pueden generar invitaciones;
- revocar invitaciones pendientes requiere `memberships.manage_staff` y nunca modifica una membership ya aceptada;
- la persona invitada **no necesita tener rol previo** para aceptar: la autorización de aceptación proviene del token válido + email Clerk verificado coincidente;
- aceptar la invitación no permite elegir tenant ni rol desde el frontend;
- toda creación, reenvío relevante, revocación y aceptación se audita.

# 5. CRM y agenda

| Permission code | Owner | Admin | Advisor | Technician |
| --- | --- | --- | --- | --- |
| `customers.read` | ✅ | ✅ | ✅ | — |
| `customers.create` | ✅ | ✅ | ✅ | — |
| `customers.update` | ✅ | ✅ | ✅ | — |
| `customers.archive` | ✅ | ✅ | — | — |
| `vehicles.read` | ✅ | ✅ | ✅ | A |
| `vehicles.create` | ✅ | ✅ | ✅ | — |
| `vehicles.update` | ✅ | ✅ | ✅ | — |
| `vehicle_owners.manage` | ✅ | ✅ | ✅ | — |
| `appointments.read` | ✅ | ✅ | ✅ | — |
| `appointments.manage` | ✅ | ✅ | ✅ | — |

<aside>
🧑‍🔧

Un técnico no obtiene `customers.read`. Cuando una orden asignada necesite mostrar identidad mínima del cliente, la API devolverá un DTO operacional mínimo, no acceso general al CRM.

</aside>

# 6. Recepción, firmas y media

| Permission code | Owner | Admin | Advisor | Technician |
| --- | --- | --- | --- | --- |
| `receptions.read` | ✅ | ✅ | ✅ | A |
| `receptions.create` | ✅ | ✅ | ✅ | — |
| `receptions.update_open` | ✅ | ✅ | ✅ | — |
| `receptions.close` | ✅ | ✅ | ✅ | — |
| `receptions.reopen` | ✅ | ✅ | — | — |
| `signatures.capture` | ✅ | ✅ | ✅ | — |
| `signatures.read` | ✅ | ✅ | ✅ | — |
| `media.read` | ✅ | ✅ | ✅ | A |
| `media.upload` | ✅ | ✅ | ✅ | A |
| `media.remove_unattached` | ✅ | ✅ | — | — |

# 7. Órdenes de trabajo

| Permission code | Owner | Admin | Advisor | Technician |
| --- | --- | --- | --- | --- |
| `orders.read` | ✅ | ✅ | ✅ | A |
| `orders.create` | ✅ | ✅ | ✅ | — |
| `orders.transition` | ✅ | ✅ | ✅ | — |
| `orders.assign` | ✅ | ✅ | ✅ | — |
| `orders.cancel` | ✅ | ✅ | ✅ | — |
| `orders.reopen` | ✅ | ✅ | — | — |
| `order_items.read` | ✅ | ✅ | ✅ | A |
| `order_items.adjust_before_completion` | ✅ | ✅ | ✅ | — |
| `warranty.override_before_completion` | ✅ | ✅ | ✅ | — |
| `warranty.correct_after_completion` | ✅ | ✅ | — | — |

Las correcciones posteriores a finalización deben exigir motivo y generar auditoría; nunca sobrescribir silenciosamente el historial.

# 8. Diagnóstico

| Permission code | Owner | Admin | Advisor | Technician |
| --- | --- | --- | --- | --- |
| `diagnostics.read` | ✅ | ✅ | ✅ | A |
| `diagnostics.write` | ✅ | ✅ | ✅ | A |
| `diagnostics.close` | ✅ | ✅ | ✅ | A |

# 9. Catálogo y cotizaciones

| Permission code | Owner | Admin | Advisor | Technician |
| --- | --- | --- | --- | --- |
| `catalog.read` | ✅ | ✅ | ✅ | ✅ |
| `catalog.manage` | ✅ | ✅ | — | — |
| `inventory.read` | ✅ | ✅ | ✅ | ✅ |
| `inventory.movements.read` | ✅ | ✅ | ✅ | A |
| `inventory.receive` | ✅ | ✅ | — | — |
| `inventory.adjust` | ✅ | ✅ | — | — |
| `inventory.transfer` | ✅ | ✅ | — | — |
| `inventory.consume_assigned` | ✅ | ✅ | ✅ | A |
| `quotes.propose_labor_adjustment` | ✅ | ✅ | ✅ | A |
| `quotes.read` | ✅ | ✅ | ✅ | — |
| `quotes.create` | ✅ | ✅ | ✅ | — |
| `quotes.update_draft` | ✅ | ✅ | ✅ | — |
| `quotes.override_price` | ✅ | ✅ | ✅ | — |
| `quotes.send` | ✅ | ✅ | ✅ | — |
| `quote_authorizations.read` | ✅ | ✅ | ✅ | — |
| `quote_authorizations.record_manual` | ✅ | ✅ | ✅ | — |

Una versión enviada no se modifica aunque el actor tenga `quotes.update_draft`; debe generarse una nueva versión. `quotes.propose_labor_adjustment` permite a technician **solo con assignment activo** crear una cotización `supplemental` en draft con líneas `labor`; no concede `quotes.send`, override general de precios ni autorización. `inventory.consume_assigned` solo registra consumo/return contra repuestos de la orden asignada y nunca permite receipt/adjust/transfer.

`quotes.send` autoriza el comando de envío y, cuando el canal necesita enlace público, permite que el flujo de dominio/worker emita `quote_authorization_tokens` para la versión enviada. No existe un permiso genérico para fabricar tokens arbitrarios. `quote_authorizations.record_manual` registra una decisión presencial/manual y **no** crea ni simula un token público.

# 10. Reparación, actividad técnica y calidad

| Permission code | Owner | Admin | Advisor | Technician |
| --- | --- | --- | --- | --- |
| `work_activities.read` | ✅ | ✅ | ✅ | A |
| `work_activities.manage` | ✅ | ✅ | ✅ | A |
| `technician_logs.read` | ✅ | ✅ | ✅ | A |
| `technician_logs.create` | ✅ | ✅ | — | A |
| `quality_checks.read` | ✅ | ✅ | ✅ | A |
| `quality_checks.perform` | ✅ | ✅ | ✅ | Q |

Para `Q`, el técnico requiere asignación `quality_control`. La política baseline debe impedir que el mismo actor apruebe su propio trabajo cuando el taller tenga otro actor disponible; cualquier excepción en talleres unipersonales debe quedar auditada.

# 11. Entrega y pagos del cliente final

| Permission code | Owner | Admin | Advisor | Technician |
| --- | --- | --- | --- | --- |
| `deliveries.read` | ✅ | ✅ | ✅ | — |
| `deliveries.complete` | ✅ | ✅ | ✅ | — |
| `customer_payments.read` | ✅ | ✅ | ✅ | — |
| `customer_payments.record` | ✅ | ✅ | ✅ | — |
| `customer_payments.allocate` | ✅ | ✅ | ✅ | — |
| `customer_payments.reverse` | ✅ | ✅ | — | — |
| `customer_payment_reconciliation.read` | ✅ | ✅ | — | — |
| `customer_payment_reconciliation.run` | ✅ | ✅ | — | — |

# 12. Comunicaciones

## Acceso público del cliente — permisos de emisión

| Permission code | Owner | Admin | Advisor | Technician |
| --- | --- | --- | --- | --- |
| `customer_access_tokens.read` | ✅ | ✅ | ✅ | — |
| `customer_access_tokens.create` | ✅ | ✅ | ✅ | — |
| `customer_access_tokens.revoke` | ✅ | ✅ | ✅ | — |

Emitir o revocar un enlace de seguimiento desde la operación interna requiere estos permisos. El worker puede **entregar/enviar** el enlace de forma asíncrona, pero la creación del token debe quedar atribuida a una membership autorizada que ejecutó el comando de dominio; el worker no crea autoridad autónoma. Esto no convierte al cliente externo en miembro del tenant.

| Permission code | Owner | Admin | Advisor | Technician |
| --- | --- | --- | --- | --- |
| `messages.read` | ✅ | ✅ | ✅ | — |
| `messages.send` | ✅ | ✅ | ✅ | — |
| `reminders.manage` | ✅ | ✅ | ✅ | — |

# 13. Privacidad y derechos de titulares

| Permission code | Owner | Admin | Advisor | Technician |
| --- | --- | --- | --- | --- |
| `privacy_consents.read` | ✅ | ✅ | ✅ | — |
| `privacy_consents.capture` | ✅ | ✅ | ✅ | — |
| `data_subject_requests.create` | ✅ | ✅ | ✅ | — |
| `data_subject_requests.read` | ✅ | ✅ | — | — |
| `data_subject_requests.resolve` | ✅ | ✅ | — | — |
| `privacy_data.export` | ✅ | ✅ | — | — |
| `privacy_data.anonymize_or_delete` | ✅ | ✅ | — | — |
| `privacy_incidents.manage` | ✅ | ✅ | — | — |

# 14. Suscripción SaaS y documentos legales

| Permission code | Owner | Admin | Advisor | Technician |
| --- | --- | --- | --- | --- |
| `subscription.read` | ✅ | ✅ | — | — |
| `subscription.manage` | ✅ | — | — | — |
| `legal_acceptances.read` | ✅ | ✅ | — | — |
| `legal_acceptances.accept_for_tenant` | ✅ | — | — | — |

# 15. Dashboard, reportes, notificaciones e integraciones

| Permission code | Owner | Admin | Advisor | Technician |
| --- | --- | --- | --- | --- |
| `dashboard.operational.read` | ✅ | ✅ | ✅ | A |
| `dashboard.business.read` | ✅ | ✅ | — | — |
| `reports.operational.read` | ✅ | ✅ | ✅ | — |
| `reports.financial.read` | ✅ | ✅ | — | — |
| `exports.operational.create` | ✅ | ✅ | — | — |
| `notifications.read` | ✅ | ✅ | ✅ | ✅ |
| `notifications.preferences.update_self` | ✅ | ✅ | ✅ | ✅ |
| `integrations.read` | ✅ | ✅ | — | — |
| `integrations.manage` | ✅ | ✅ | — | — |

`dashboard.business.read` habilita ventas, recaudo, cartera, ticket promedio, participación por `sales_originator_membership_id`, productos vendidos y stock; queda limitado a owner/admin. `dashboard.operational.read` muestra operación y, para technician, solo alcance asignado. Los reportes y exports deben respetar los mismos filtros de tenant y minimización de PII que los endpoints operativos. `integrations.manage` nunca expone secretos existentes en texto plano; solo permite configurar/rotar mediante flujos seguros. Para WhatsApp, owner/admin pueden iniciar/desconectar la integración del **propio tenant** mediante onboarding autorizado; no pueden seleccionar ni operar WABA/`phone_number_id` de otro taller. La propiedad y facturación Meta siguen siendo del taller (`billing_mode='tenant_direct'`), no de ILVOX.

# 15.1 Cliente externo — no es un rol RBAC

El cliente final que consulta el estado de su vehículo **no recibe `user` ni `membership`**; no existe un rol RBAC para él. Su acceso se autoriza mediante `customer_order_access_tokens` de propósito limitado.

Reglas:

- no participa en `role_permissions`;
- solo puede leer el DTO público de la orden exacta asociada al token;
- seguimiento de orden, autorización de cotización y futuras acciones sensibles usan tokens diferentes;
- emitir/revocar un token de seguimiento desde la operación interna requiere `customer_access_tokens.create` / `customer_access_tokens.revoke`;
- no puede convertir un token público en sesión interna ni acceder a endpoints protegidos;
- un token público nunca concede permisos sobre otra orden, otro cliente ni otro tenant.

# 16. Reglas de propiedad y escalada de privilegios

1. Todo taller debe conservar **al menos un owner activo**.
2. Puede haber más de un owner si el negocio lo requiere.
3. Un owner no puede revocar/degradar al último owner.
4. Solo owner puede asignar/revocar `owner` o `admin`.
5. Admin solo gestiona `service_advisor` y `technician`.
6. Nadie puede modificar sus propios roles mediante endpoints genéricos.
7. `ownership.transfer` exige operación dedicada, reautenticación reciente y auditoría.
8. Toda modificación de membership/rol registra actor, target membership, before/after, tenant y request_id.
Las reglas 4–5 aplican también a comandos de estado de membership (S1-06): suspender/revocar una membership exige
`memberships.manage_staff` y el permiso de asignación de cada rol que la membership tiene; admin solo gestiona
memberships de staff (o sin roles). La regla 6 se extiende a estado: nadie suspende/revoca su propia membership por
endpoints genéricos (salir del taller: flujo dedicado pendiente). Los intentos denegados se auditan (`denied`).

9. El rol `owner` no concede acceso a infraestructura ILVOX, secretos, DB admin, webhooks internos ni otros tenants.

# 17. Recursos asignados — semántica de A

Para un `technician`, **A** requiere una relación válida de asignación en el mismo tenant:

```
TenantContext.membershipId
      ↓
assignments
      ↓
service_order
      ↓
recurso operativo
```

La API no debe aceptar `assigned=true` desde el cliente. La asignación se resuelve en PostgreSQL.

El DTO técnico debe minimizar PII y datos financieros: el técnico puede recibir placa, vehículo, trabajo autorizado, diagnóstico/evidencia necesaria y garantía relacionada, sin obtener acceso general a CRM, billing o pagos.

# 18. Evaluación server-side

Flujo obligatorio:

```
JWT válido
  ↓
local user
  ↓
membership activa
  ↓
roles activos
  ↓
permissions
  ↓
resource-scope check (tenant / assigned / QC)
  ↓
domain command
```

No utilizar checks dispersos como `if (role === "admin")` dentro del dominio. El código debe consultar permissions estables (`orders.assign`, `quotes.send`, etc.) y después aplicar restricciones de recurso.

**S1-08 cross-tenant:** el JWT de Clerk solo establece identidad después de verificación; seleccionar B exige una membership activa de ese usuario en B según PostgreSQL. Membership inexistente, suspendida o revocada no habilita el TenantContext; cambios toman efecto en el siguiente request. Claims `org_role`, `org_permissions` y metadata no son autoridad de roles, permisos ni tenant. IDs de otro tenant se resuelven bajo RLS antes del comando: GET membership/roles y revoke invitación devuelven el mismo 404 que un UUID inexistente, sin efecto ni auditoría en B. `audit.read` sigue sin endpoint Sprint 1 (D5).

# 19. Seeds y modelo de datos

En implementación:

- `roles.code` será estable/único para los cuatro roles baseline.
- `permissions.code` será estable/único.
- `role_permissions` contiene exactamente la matriz aprobada.
- `membership_roles` asigna roles dentro del tenant.
- seeds deben ser idempotentes.
- eliminar o renombrar un permission code requiere migración explícita; no edición manual de producción.
- custom roles quedan fuera del MVP y requieren decisión futura.

# 20. Auditoría obligatoria

Eventos mínimos:

- `membership.invited`;
- `membership.activated`;
- `membership.suspended`;
- `membership.revoked`;
- `role.assigned`;
- `role.revoked`;
- `ownership.transferred`;
- intentos de escalada de privilegio relevantes;
- corrección de garantía posterior a finalización;
- reverso de pago;
- `inventory.initial_stock_recorded`;
- `inventory.receipt_recorded`;
- `inventory.adjustment_in_recorded`;
- `inventory.adjustment_out_recorded`;
- `inventory.transfer_recorded`;
- `inventory.consumption_recorded`;
- `inventory.return_recorded`;
- operaciones de privacidad/exportación.

El catálogo completo implementado de Sprint 1 (18 acciones, incluidos `workshop.created`, `membership.invitation_*` e `identity.*`) y la política de denegados están en Operación §5.2. Los denegados de autorización de dominio listados allí son los «intentos de escalada de privilegio relevantes» para Sprint 1. Las decisiones D1–D6 de esa sección permanecen abiertas.

`inventory.adjustment_out_recorded` es sensible al nivel de un reverso de pago: exige `reason` no vacío y debe permitir correlacionar actor, `catalog_item_id`, `location_id`, cantidad, `balance_before`, `balance_after`, `inventory_movement.id` y `request_id`. Transferencias auditan un evento lógico con `transfer_group_id` y referencias a ambos movimientos.

Nunca registrar tokens o secretos en el audit log.

# 21. Quality Gate RBAC

- [ ]  Cada permission code existe en catálogo de permisos.
- [ ]  `role_permissions` coincide con esta matriz.
- [ ]  Usuario sin permission obtiene 403 aunque la UI muestre/inyecte la acción.
- [ ]  Owner puede ejecutar sus permisos owner-only.
- [ ]  Admin no puede asignar owner/admin ni transferir ownership.
- [ ]  Advisor no puede administrar memberships/roles/billing SaaS.
- [ ]  Technician solo accede recursos asignados.
- [ ]  Technician no obtiene acceso general a customer PII, cotizaciones financieras ni pagos.
- [ ]  Último owner no puede ser eliminado/degradado.
- [ ]  Cambio de roles toma efecto sin requerir nueva identidad de Clerk.
- [ ]  Manipular role/permission/tenant en payload no cambia autorización.
- [ ]  Cross-tenant continúa rechazado aunque dos memberships tengan el mismo rol.
- [ ]  Cambios de membership/roles generan audit log.
- [ ]  Toda mutación de inventario genera audit log correlacionado con su `inventory_movement`.
- [ ]  `adjustment_out` sin razón es rechazado; con razón conserva balance antes/después y actor en auditoría.
- [ ]  Tests cubren al menos un ALLOW y un DENY por permiso sensible/rol.
- [ ]  Tests de A verifican asignado vs no asignado.
- [ ]  Tests de Q verifican control de calidad y separación de funciones.

<aside>
🚦

**Sprint 1 no puede pasar** hasta demostrar que la matriz se aplica realmente en API/DB context. La existencia de filas en `role_permissions` por sí sola no constituye PASS.

</aside>

# 22. Fuera de alcance de esta matriz

- privilegios del equipo interno ILVOX;
- acceso de soporte/impersonation;
- roles custom creados por talleres;
- API keys machine-to-machine;
- permisos de proveedores externos;
- permisos físicos de PostgreSQL (`ilvox_app`, worker, migrator), que pertenecen al Security Baseline.

Antes del piloto, el acceso interno ILVOX a datos de talleres deberá tener su propio modelo explícito y auditado; nunca reutilizar `owner/admin` de un tenant.
