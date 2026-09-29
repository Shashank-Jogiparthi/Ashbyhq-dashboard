/* =====================================================================
   STAFF ROSTER — the durable, committed copy of the real org chart.

   WHY this file exists: the four permitted CRM tables (client_profiles,
   clients_additional_info, ashby_joblinks, ashby_joblink_questions) carry
   only the CA/OM *UUIDs* on each applicant row (career_associate_id /
   career_associate_manager_id). They never carry a staff member's NAME,
   EMAIL or ROLE, and they contain no admins at all. The names/emails lived
   only in public.dice_ca_accounts, which is out of bounds for this platform.

   So this roster is the single source of staff IDENTITY (uuid -> name +
   email + role), supplied by the operator ("store those and discontinue").
   The CA->OM EDGE is NOT stored here — it is derived live from
   clients_additional_info by staff-directory.js, so this file can never
   drift from the CRM on who reports to whom.

   role here is the platform role (ca/ops/admin). CA and Junior CA both map
   to 'ca' (staff.role has no junior tier). Emails are normalised to
   lower-case by the importer.
   ===================================================================== */

// 59 Career Associates (from the operator's list). extId = CRM career_associate_id.
export const CA_ROSTER = [
  { extId: 'c0165dfa-02d7-46f8-b5f2-697ac65b3776', name: 'Mohammad Hafeez', email: 'mohammadhafeez@applywizz.com' },
  { extId: 'c9b56bdb-628f-49e0-be0e-9c42ea58d50f', name: 'Sharanya Peddi', email: 'sharanyapeddi@applywizz.ai' },
  { extId: 'b67b8e0f-b864-4126-b915-f249a6eee25c', name: 'Amulya Ravula', email: 'amulyaravula@applywizz.com' },
  { extId: '664e2c55-0521-4587-97eb-8f363bb869f0', name: 'Saikiran Choutupelly', email: 'saikiran.choutupelly@applywizz.ai' },
  { extId: '32fff2b9-2f22-47e7-b55e-b6583b9214b7', name: 'Akhila Karike', email: 'akhilakarike@applywizz.ai' },
  { extId: '3af2236d-20ea-41bf-840a-97f4ef91beaa', name: 'vidhya palle', email: 'vidhya@applywizz.com' },
  { extId: 'a05be797-9b67-4bcb-b582-5c9b549e2003', name: 'Tulasi Thatikonda', email: 'tulasithatikonda@applywizz.ai' },
  { extId: '59da955e-5aa9-4bf5-8335-bad0ea9a9b08', name: 'Suguru Dheeraj', email: 'sugurudheeraj@applywizz.ai' },
  { extId: 'bc53cb5c-f9e9-4109-be09-40bb81852a8e', name: 'Mohammad Zia', email: 'ziamd@applywizz.com' },
  { extId: '2480a4db-67df-4d90-990a-03e5dc67308f', name: 'Gummadidala Kaveri', email: 'kaverigummadidala@applywizz.com' },
  { extId: '9c3a76a8-a67e-460c-9236-72da7ba3e37a', name: 'Neha Balla', email: 'nehaballa@applywizz.ai' },
  { extId: 'c14bdaea-e9c3-44a7-9ddc-38f04c3e6706', name: 'Jamalpuri Shireesha', email: 'shireeshaj@applywizz.com' },
  { extId: '5297728f-b2bf-4d4d-a3fa-0f2943fbcbe5', name: 'Arun Gogulothu', email: 'arungogulothu@applywizz.ai' },
  { extId: '353f21f6-5629-4a15-b0a2-7b3feb5a4e97', name: 'Bhavana Swamulapally', email: 'bhavanaswamulapally@applywizz.ai' },
  { extId: '0e7f2701-8aec-468b-995c-48ffc9479471', name: 'Venkatesh Goud G', email: 'venkateshgoudg@applywizz.ai' },
  { extId: '48148ef9-f476-4e3e-9e80-0b4246684e75', name: 'Shravani', email: 'shravani@applywizz.com' },
  { extId: '8c37942c-d522-4ede-930f-4bd4239d6d88', name: 'Aravind Bommena', email: 'aravindbommena@applywizz.ai' },
  { extId: '29b86adf-4e0d-442f-afe9-1e7951b95b3a', name: 'Aparna', email: 'aparna@applywizz.com' },
  { extId: '2bb970a6-58cb-4869-83a2-feb0e5210eeb', name: 'Swapna Ravula', email: 'swapnaravula@applywizz.ai' },
  { extId: 'a704d5bb-b991-43cf-83d2-f2c087b82804', name: 'khajipuram supriya', email: 'supriya@applywizz.com' },
  { extId: 'd4085245-1626-46cb-9cbf-1a6fdbfcebbe', name: 'Sana', email: 'sana@applywizz.com' },
  { extId: 'c4caaf5d-637c-498e-a939-3e3bc0d5ab65', name: 'Deekshitha', email: 'deekshitha@applywizz.com' },
  { extId: 'b56f3c6b-c33a-4f90-8125-f4c1fc0494a1', name: 'Munigela Srujana', email: 'srujana@applywizz.com' },
  { extId: '9b954a35-adf0-46cd-8b91-9a50e812b9f2', name: 'Navya Repaka', email: 'navya@applywizz.com' },
  { extId: 'bb69a47c-39aa-4eac-9b03-4e98d9125ce0', name: 'Harika Medikayala', email: 'harika@applywizz.com' },
  { extId: 'f1b2e868-eca8-4e50-bae6-be41fa664c6f', name: 'Bandi Ashwitha', email: 'ashwitha@applywizz.com' },
  { extId: 'bcd2a69f-0ce8-4546-96ac-e4cd6110f259', name: 'Manusha Nune', email: 'manushanune@applywizz.com' },
  { extId: 'f373d602-fcee-4382-a3c3-5ac0ac1b9c3f', name: 'Soumya Mamindla', email: 'soumyamamindla@applywizz.com' },
  { extId: '75baf7c8-b0c8-46ed-8274-421fde632df6', name: 'Sherupally Shruthi', email: 'shruthisherupally@applywizz.com' },
  { extId: '07c6f0dc-ceca-4c5b-9fd6-e5c49e0671a0', name: 'Sowmya chilumula', email: 'sowmya@applywizz.com' },
  { extId: 'f0200139-40ae-4ebf-bbf1-4bbd8fc40af2', name: 'Santhoshini G', email: 'santhoshinig@applywizz.com' },
  { extId: '831b40c8-8ba0-4d50-9a8b-384ec1c211ff', name: 'Sreeja', email: 'sreeja@applywizz.com' },
  { extId: 'd7de6b12-d97f-494c-b6b8-d294e6558229', name: 'Meenakshi Kuncham', email: 'meenakshi@applywizz.com' },
  { extId: '53a008e1-17ed-4d5b-abe3-4001cdf44772', name: 'Rakesh Kancharla', email: 'rakesh@applywizz.com' },
  { extId: '4c986ffe-728e-43bd-bd9e-20f101a614e1', name: 'Pravalika Patharla', email: 'pravalika@applywizz.com' },
  { extId: 'bfdc5498-063a-440c-8a4c-d867016ea720', name: 'Nari Ankitha', email: 'nariankitha@applywizz.ai' },
  { extId: 'a1c28829-01ac-47a9-8859-a2e9b6184ef2', name: 'Roshini Gotte', email: 'roshinigotte@applywizz.ai' },
  { extId: '8480837b-4138-4bb9-9046-e0186523407f', name: 'Premchand Gangi', email: 'premchandgangi@applywizz.ai' },
  { extId: 'db31be56-1730-41dc-9082-21895cf6e58a', name: 'Likhitha Duvvala', email: 'likhithaduvvala@applywizz.ai' },
  { extId: '962023b2-b089-4e15-96a4-c6af0f6925eb', name: 'Alekhya Ashangari', email: 'alekhyaashangari@applywizz.ai' },
  { extId: '6b5686ed-8ae8-4481-9f50-17475a02be64', name: 'Ramyasri', email: 'ramyasri@applywizz.com' },
  { extId: '5815fd7e-da56-4455-a96d-406093288b39', name: 'Kavya', email: 'kavya@applywizz.com' },
  { extId: '4bb5e4c1-7274-41fa-8925-449399335853', name: 'shivani kola', email: 'kolashivani@applywizz.com' },
  { extId: 'aae784eb-f821-44f8-889a-bca30eae7812', name: 'Kiran Reddy Pappula', email: 'kiranreddypappula@applywizz.ai' },
  { extId: '300006ca-a057-4d03-8992-f3aff75fb53e', name: 'Sai Pavan Bhoompally', email: 'saipavan@applywizz.com' },
  { extId: '216536c0-8d89-4377-b457-c79a13b28765', name: 'Nagaraju Mashti', email: 'nagarajumashti@applywizz.ai' },
  { extId: '928ec368-a690-45e5-b9ee-dd04c838115c', name: 'Saritha Ganne', email: 'saritha.ganne@applywizz.com' },
  { extId: 'b723dbbb-9ddf-4364-a755-c2ac7448ae62', name: 'Prasanna LaxmiKapuraboina', email: 'prasannalaxmikapuraboina@applywizz.ai' },
  { extId: 'adffca8f-1746-4fc1-8ae4-309138ceca63', name: 'Nagaraju Diviti', email: 'nagarajudiviti@applywizz.ai' },
  { extId: '0741bac7-cbbe-4fe1-ac1d-9aea1dd9d2d7', name: 'VinayKumar Bollam', email: 'vinaykumarbollam@applywizz.ai' },
  { extId: '753e0ab8-7c0c-4715-b37b-867041acfdd4', name: 'Maskuri Rathnamala', email: 'RathnamalaM@Applywizz.com' },
  { extId: '06c8abe9-f3b4-4df4-9657-5284b81b5d03', name: 'PavanKumar Veerabathini', email: 'pavankumarveerabathini@applywizz.ai' },
  { extId: '1c4e7dab-3796-4c25-9fd7-e8f9452cb34c', name: 'Rachana', email: 'rachana@applywizz.com' },
  { extId: '76e3d5eb-be04-43f9-a993-08ace888b666', name: 'Sahithi', email: 'sahithi@applywizz.com' },
  { extId: 'eec9bdf2-ceb8-453c-8f7a-133ecfa659bb', name: 'Shivani Pentham', email: 'shivani@applywizz.com' },
  { extId: '86026266-b46b-42cb-b198-bc52f83d2c80', name: 'Manasa', email: 'manasa@applywizz.com' },
  { extId: '720174ea-6bef-4c4b-b482-41822f57a879', name: 'Ruchitha Bongaram', email: 'ruchitha@applywizz.com' },
  { extId: '3a4e0d50-dd5a-4140-9099-1652ef725753', name: 'Kappera Sandeep', email: 'ksandeepreddy@applywizz.com' },
  { extId: '0441e046-058c-4162-b50f-b6203e89b6de', name: 'Sai Prasanna', email: 'saiprasanna@applywizz.com' }
];

// The two Operational Managers (CAM). extId = CRM career_associate_manager_id.
export const MANAGER_ROSTER = [
  { extId: '9dc9376e-fbc5-440b-932f-38da10b89a70', name: 'balaji', email: 'balaji@applywizz.ai' },
  { extId: 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744', name: 'RK', email: 'ramakrishnaa.tejavath@applywizz.ai' }
];

// Admins (operator chose to drop Sharan Srikar; two remain).
export const ADMIN_ROSTER = [
  { extId: 'f107eb9b-5042-4ec9-a1ee-a4826002186a', name: 'Anusha Bandreddy', email: 'AnushaBandreddy@Applywizz.ai' },
  { extId: '4c50c1e6-3591-48ce-a1bc-e101f83da3da', name: 'Rama Krishna Chanda', email: 'Ramakrishna@Applywizz.ai' }
];

// Legacy @applywizz.local test fixtures. These are NOT part of the real CRM
// tree. seedStaffDirectory() still retires them (active=0) so a host that has
// not run the purge keeps them out of sign-in; the actual removal is the staff
// purge (connector/staff-purge.js): a fixture that owns nothing is DELETED, and
// one still pinned by unresolvable work or SUCCESS history is RETIRED so no
// foreign key ever breaks. The real @applywizz.com/.ai staff are always kept.
export const FIXTURES_TO_RETIRE = [
  'admin2026@applywizz.local',
  'sana@applywizz.local',
  'sugurudheeraj@applywizz.local',
  'arjun.cam@applywizz.local',
  'dev@applywizz.local'
];
