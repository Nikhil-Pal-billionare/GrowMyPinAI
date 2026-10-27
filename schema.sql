-- GrowMyPin Autopilot - Supabase schema
-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run

create table if not exists accounts (
  id uuid primary key,                       -- same as auth.users.id
  email text,
  name text,
  phone text,
  platform text default 'shopify',           -- shopify | etsy
  store_url text,
  niche text,
  pins_per_day int default 5,

  -- Pinterest connection
  pin_access_token text,
  pin_refresh_token text,
  pin_token_expires_at timestamptz,
  pin_username text,
  board_ids text[] default '{}',

  -- Billing (Razorpay UPI AutoPay)
  billing_status text default 'none',        -- none | active | past_due | locked
  posting_paused boolean default false,
  rzp_customer_id text,
  rzp_token_id text,
  cycle_start date,
  cycle_end date,
  cycle_views int default 0,
  milestone_charged int default 0,           -- rupees charged or pending as milestone in this cycle

  last_daily_run date,
  created_at timestamptz default now()
);

create table if not exists products (
  id bigint generated always as identity primary key,
  user_id uuid not null references accounts(id) on delete cascade,
  title text not null,
  link text not null,
  image_url text,
  description text,
  price text,
  last_used_at timestamptz,
  use_count int default 0,
  created_at timestamptz default now()
);
create index if not exists products_user_idx on products(user_id);

create table if not exists pin_jobs (
  id bigint generated always as identity primary key,
  user_id uuid not null references accounts(id) on delete cascade,
  run_date date not null,
  slot int not null,
  run_at timestamptz not null,
  status text default 'queued',              -- queued | running | posted | failed | skipped
  product_id bigint,
  board_id text,
  style text,
  title text,
  description text,
  alt_text text,
  image_url text,
  pinterest_pin_id text,
  error text,
  created_at timestamptz default now(),
  unique (user_id, run_date, slot)
);
create index if not exists pin_jobs_due_idx on pin_jobs(status, run_at);

create table if not exists charges (
  id bigint generated always as identity primary key,
  user_id uuid not null references accounts(id) on delete cascade,
  kind text not null,                        -- base | milestone
  amount int not null,                       -- rupees
  for_cycle_start date,                      -- which cycle this charge pays for
  rzp_order_id text,
  rzp_payment_id text,
  status text default 'created',             -- created | pending | captured | failed
  note text,
  created_at timestamptz default now()
);
create index if not exists charges_order_idx on charges(rzp_order_id);
create index if not exists charges_user_idx on charges(user_id);

-- Lock tables: only the server (service role key) can read/write.
-- The browser never talks to these tables directly.
alter table accounts enable row level security;
alter table products enable row level security;
alter table pin_jobs enable row level security;
alter table charges enable row level security;

-- Public storage bucket for generated pin images
insert into storage.buckets (id, name, public)
values ('pins', 'pins', true)
on conflict (id) do nothing;
