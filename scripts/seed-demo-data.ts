/**
 * Nemo B2B - Demo Data Seeder
 * 
 * Populates the database with realistic demo data for testing and demos.
 * 
 * Usage:
 *   npx ts-node scripts/seed-demo-data.ts
 *   
 * Or after compilation:
 *   node dist/scripts/seed-demo-data.js
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Demo business data
const demoBusiness = {
  id: 'demo-business-001',
  name: 'Bloom Beauty Salon',
  phone: '+14165551234',
  email: 'hello@bloomsalon.com',
  owner_id: '00000000-0000-0000-0000-000000000001', // Replace with actual user ID
  voice_preference: 'Puck',
  subscription_tier: 'STARTER',
  subscription_status: 'ACTIVE',
};

// Demo customers
const demoCustomers = [
  {
    id: 'demo-customer-001',
    name: 'Sarah Johnson',
    phone: '+14165559001',
    email: 'sarah.j@email.com',
    notes: 'Prefers morning appointments',
    business_id: demoBusiness.id,
  },
  {
    id: 'demo-customer-002',
    name: 'Michael Chen',
    phone: '+14165559002',
    email: 'mchen@email.com',
    notes: 'Regular monthly haircut',
    business_id: demoBusiness.id,
  },
  {
    id: 'demo-customer-003',
    name: 'Emily Rodriguez',
    phone: '+14165559003',
    email: 'emily.r@email.com',
    notes: 'Color treatment specialist client',
    business_id: demoBusiness.id,
  },
  {
    id: 'demo-customer-004',
    name: 'David Kim',
    phone: '+14165559004',
    email: 'dkim@email.com',
    notes: '',
    business_id: demoBusiness.id,
  },
  {
    id: 'demo-customer-005',
    name: 'Jessica Taylor',
    phone: '+14165559005',
    email: 'jtaylor@email.com',
    notes: 'VIP client - always on time',
    business_id: demoBusiness.id,
  },
];

// Generate appointments for the next 7 days
function generateAppointments() {
  const appointments = [];
  const services = [
    { title: 'Haircut', duration: 30 },
    { title: 'Hair Color', duration: 90 },
    { title: 'Blowout', duration: 45 },
    { title: 'Manicure', duration: 30 },
    { title: 'Pedicure', duration: 45 },
    { title: 'Facial', duration: 60 },
    { title: 'Massage', duration: 60 },
  ];

  const statuses = ['SCHEDULED', 'CONFIRMED', 'COMPLETED'];
  
  for (let day = 0; day < 7; day++) {
    const date = new Date();
    date.setDate(date.getDate() + day);
    
    // 3-5 appointments per day
    const numAppointments = 3 + Math.floor(Math.random() * 3);
    
    for (let i = 0; i < numAppointments; i++) {
      const service = services[Math.floor(Math.random() * services.length)];
      const customer = demoCustomers[Math.floor(Math.random() * demoCustomers.length)];
      const hour = 9 + Math.floor(Math.random() * 8); // 9 AM to 5 PM
      const minute = Math.random() > 0.5 ? 0 : 30;
      
      date.setHours(hour, minute, 0, 0);
      
      // Past appointments are completed, future ones are scheduled/confirmed
      const status = day < 0 
        ? 'COMPLETED' 
        : day === 0 
          ? statuses[Math.floor(Math.random() * 2)] 
          : 'SCHEDULED';
      
      appointments.push({
        id: `demo-apt-${day}-${i}`,
        title: service.title,
        description: `${service.title} appointment with ${customer.name}`,
        scheduled_at: new Date(date).toISOString(),
        duration_min: service.duration,
        reminder_enabled: true,
        reminder_hours: 24,
        status: status,
        business_id: demoBusiness.id,
        customer_id: customer.id,
      });
    }
  }
  
  return appointments;
}

// Generate call logs for completed appointments
function generateCallLogs(appointments: any[]) {
  const callLogs = [];
  const outcomes = ['ANSWERED', 'CONFIRMED', 'NO_ANSWER', 'VOICEMAIL'];
  
  for (const apt of appointments) {
    if (apt.status === 'COMPLETED' || apt.status === 'CONFIRMED') {
      const outcome = apt.status === 'CONFIRMED' 
        ? 'CONFIRMED' 
        : outcomes[Math.floor(Math.random() * outcomes.length)];
      
      callLogs.push({
        id: `demo-call-${apt.id}`,
        call_type: 'REMINDER',
        call_outcome: outcome,
        duration_sec: outcome === 'ANSWERED' || outcome === 'CONFIRMED' 
          ? 30 + Math.floor(Math.random() * 60) 
          : outcome === 'VOICEMAIL' ? 25 : null,
        room_name: null,
        sip_call_id: `SIP_${Math.random().toString(36).substr(2, 9)}`,
        transcript: null,
        summary: null,
        business_id: demoBusiness.id,
        customer_id: apt.customer_id,
        appointment_id: apt.id,
      });
    }
  }
  
  return callLogs;
}

async function seedDatabase() {
  console.log('🌱 Seeding Nemo B2B demo data...\n');

  try {
    // 1. Create demo business
    console.log('📋 Creating demo business...');
    const { error: bizError } = await supabase
      .from('b2b_businesses')
      .upsert(demoBusiness, { onConflict: 'id' });
    
    if (bizError) throw bizError;
    console.log(`   ✓ ${demoBusiness.name}`);

    // 2. Create demo customers
    console.log('\n👥 Creating demo customers...');
    const { error: custError } = await supabase
      .from('b2b_customers')
      .upsert(demoCustomers, { onConflict: 'id' });
    
    if (custError) throw custError;
    for (const c of demoCustomers) {
      console.log(`   ✓ ${c.name}`);
    }

    // 3. Create appointments
    console.log('\n📅 Creating demo appointments...');
    const appointments = generateAppointments();
    const { error: aptError } = await supabase
      .from('b2b_appointments')
      .upsert(appointments, { onConflict: 'id' });
    
    if (aptError) throw aptError;
    console.log(`   ✓ ${appointments.length} appointments created`);

    // 4. Create call logs
    console.log('\n📞 Creating demo call logs...');
    const callLogs = generateCallLogs(appointments);
    const { error: callError } = await supabase
      .from('b2b_call_logs')
      .upsert(callLogs, { onConflict: 'id' });
    
    if (callError) throw callError;
    console.log(`   ✓ ${callLogs.length} call logs created`);

    console.log('\n✅ Demo data seeded successfully!');
    console.log('\n📊 Summary:');
    console.log(`   • 1 business: ${demoBusiness.name}`);
    console.log(`   • ${demoCustomers.length} customers`);
    console.log(`   • ${appointments.length} appointments`);
    console.log(`   • ${callLogs.length} call logs`);

  } catch (error) {
    console.error('\n❌ Seeding failed:', error);
    process.exit(1);
  }
}

async function clearDemoData() {
  console.log('🧹 Clearing demo data...\n');

  try {
    // Delete in order due to foreign keys
    await supabase.from('b2b_call_logs').delete().like('id', 'demo-%');
    console.log('   ✓ Call logs cleared');
    
    await supabase.from('b2b_appointments').delete().like('id', 'demo-%');
    console.log('   ✓ Appointments cleared');
    
    await supabase.from('b2b_customers').delete().like('id', 'demo-%');
    console.log('   ✓ Customers cleared');
    
    await supabase.from('b2b_businesses').delete().like('id', 'demo-%');
    console.log('   ✓ Businesses cleared');

    console.log('\n✅ Demo data cleared!');
  } catch (error) {
    console.error('\n❌ Clear failed:', error);
    process.exit(1);
  }
}

// Main
const arg = process.argv[2];

if (arg === '--clear') {
  clearDemoData();
} else if (arg === '--help') {
  console.log(`
Nemo B2B Demo Data Seeder

Usage:
  npx ts-node scripts/seed-demo-data.ts          Seed demo data
  npx ts-node scripts/seed-demo-data.ts --clear  Clear demo data
  npx ts-node scripts/seed-demo-data.ts --help   Show this help
  `);
} else {
  seedDatabase();
}
