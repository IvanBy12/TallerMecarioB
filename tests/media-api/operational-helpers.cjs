'use strict';
const { randomUUID } = require('node:crypto');
const h = require('../crm-api/helpers.cjs');
// TEST-ONLY parent fixtures, with every existing guard enabled. This does not
// add evidence to an existing media session: uploads must use public create.
async function parent(tenant) {
  const customer = randomUUID(), vehicle = randomUUID(), reception = randomUUID(), damage = randomUUID();
  let consent;
  await h.admin.begin(async (tx) => {
    await tx`INSERT INTO customers(id,tenant_id,first_name,last_name,phone)
      VALUES(${customer},${tenant.tenantId},'Test','Customer','3000000000')`;
    await tx`INSERT INTO vehicles(id,tenant_id,plate,vehicle_type,brand,model)
      VALUES(${vehicle},${tenant.tenantId},${'B'+vehicle.replaceAll('-', '').slice(0,12).toUpperCase()},'car','Test','Test')`;
    await tx`INSERT INTO vehicle_owners(id,tenant_id,vehicle_id,customer_id,relationship_type,is_primary)
      VALUES(${randomUUID()},${tenant.tenantId},${vehicle},${customer},'owner',true)`;
    consent = await h.seedServiceConsent(tx, tenant.tenantId, customer);
    await tx`INSERT INTO receptions(id,tenant_id,vehicle_id,customer_id,privacy_consent_id,received_by_membership_id,mileage_km)
      VALUES(${reception},${tenant.tenantId},${vehicle},${customer},${consent},${tenant.owner.membershipId},0)`;
    await tx`INSERT INTO vehicle_damages(id,tenant_id,reception_id,zone_code,damage_type)
      VALUES(${damage},${tenant.tenantId},${reception},'front','scratch')`;
  });
  return { customer, vehicle, reception, damage, consent };
}
module.exports = { parent };
