import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://tvvknokblzmjxlixdqce.supabase.co';
const supabaseKey = 'sb_publishable_Q-qYBUYBl_CITsZv6z4PtQ_LCiTOcNn';

export const supabase = createClient(supabaseUrl, supabaseKey);
