import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";

// Generates realistic, clearly-flagged demo data for the buyer marketplace,
// admin console, and artisan analytics dashboard: seed artisans and buyers,
// products across real Indian craft categories with correct regional
// associations, a mix of moderation states, inquiries, and historical view
// data. Every row this script creates has is_seed = true (users, products;
// inquiries and product_views cascade-delete with their parent row) so it
// can be told apart from real data and wiped cleanly.
//
// Re-runnable: every run starts by deleting all existing is_seed rows, then
// regenerates the full set fresh. Run with --wipe to only delete, without
// regenerating.
//
// Usage:
//   node scripts/seed-demo-data.mjs          seed (wipes old seed data first)
//   node scripts/seed-demo-data.mjs --wipe    wipe only, nothing regenerated

const WIPE_ONLY = process.argv.includes("--wipe");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env to run this.");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "product-images";
const SEED_IMAGE_ROOT = "seed-images";

const CRAFT_FOLDERS = {
  "handloom-textiles": "Handloom textiles",
  "pottery-terracotta": "Pottery and terracotta",
  "bamboo-cane": "Bamboo and cane",
  "brassware-metalwork": "Brassware and metalwork",
  "block-print": "Block print",
  jewellery: "Jewellery",
  "wood-carving": "Wood carving",
};

function pastTimestamp(minDaysAgo, maxDaysAgo) {
  const daysAgo = minDaysAgo + Math.random() * (maxDaysAgo - minDaysAgo);
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function placeholderImageUrl(label) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">` +
    `<rect width="800" height="600" fill="#FBF4EA"/>` +
    `<text x="50%" y="50%" font-family="sans-serif" font-size="28" fill="#C1502E" text-anchor="middle" dominant-baseline="middle">Photo pending: ${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

async function loadCraftImages() {
  const imagesByFolder = {};
  for (const [folder, label] of Object.entries(CRAFT_FOLDERS)) {
    const dir = join(SEED_IMAGE_ROOT, folder);
    const urls = [];
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((file) =>
        [".jpg", ".jpeg", ".png", ".webp"].includes(extname(file).toLowerCase()),
      );
      for (const file of files) {
        const buffer = readFileSync(join(dir, file));
        const storagePath = `seed/${folder}/${file}`;
        const ext = extname(file).toLowerCase();
        const contentType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
        const { error } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(storagePath, buffer, { contentType, upsert: true });
        if (error) {
          console.warn(`  Could not upload ${file} for "${label}": ${error.message}`);
          continue;
        }
        const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
        urls.push(data.publicUrl);
      }
    }
    imagesByFolder[folder] = urls;
    console.log(
      urls.length > 0
        ? `  ${label}: ${urls.length} photo(s) uploaded from seed-images/${folder}/`
        : `  ${label}: no photos found in seed-images/${folder}/, using a placeholder`,
    );
  }
  return imagesByFolder;
}

function pickImage(imagesByFolder, folder, index, label) {
  const urls = imagesByFolder[folder];
  if (urls && urls.length > 0) return urls[index % urls.length];
  return placeholderImageUrl(label);
}

async function generatePassportId(year) {
  const { data, error } = await supabase.rpc("next_passport_number", { target_year: year });
  if (error) throw new Error(`Could not generate a passport id: ${error.message}`);
  return `ART-${year}-${String(data).padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------
// Artisans and their products.
//
// Every artisan's region, material, and technique reflects a real,
// well-documented Indian craft tradition (Banarasi brocade from Varanasi,
// Bidriware from Bidar, Channapatna toys from Channapatna, and so on).
// GI tags are only set where that craft genuinely holds a registered
// Geographical Indication; every other product leaves it blank rather than
// guessing.
//
// products.category only supports six values app-wide (textiles, pottery,
// jewelry, woodwork, bamboo-cane, other); block print is mapped to
// "textiles" (it is a textile technique) and brassware/metalwork to "other"
// (there is no dedicated metalwork category in the app today). The specific
// craft is still fully captured in material, technique, and the product
// title/description.
// ---------------------------------------------------------------------------

const ARTISANS = [
  {
    key: "meena-varanasi",
    displayName: "Meena Devi",
    shopName: "Ganga Silk Weaves",
    region: "Uttar Pradesh",
    pincode: "221001",
    language: "hi",
    category: "textiles",
    craftFolder: "handloom-textiles",
    material: "Silk",
    technique: "Handloom Banarasi brocade weaving with zari",
    careInstructions: "Dry clean only. Store folded in a cotton cloth, away from direct sunlight.",
    giTag: "Banaras Brocades and Sarees",
    products: [
      {
        noun: "Banarasi Silk Saree",
        color: "maroon",
        price: 8500,
        materialCost: 3200,
        weightKg: 0.6,
        timeTaken: "8 days",
        desc: "A handwoven Banarasi silk saree in maroon with a gold zari brocade border, woven on a traditional pit loom.",
      },
      {
        noun: "Banarasi Silk Saree",
        color: "royal blue",
        price: 9800,
        materialCost: 3600,
        weightKg: 0.65,
        timeTaken: "9 days",
        desc: "A royal blue Banarasi silk saree with a zari brocade pallu, handwoven in Varanasi.",
      },
      {
        noun: "Banarasi Silk Dupatta",
        color: "ivory",
        price: 3600,
        materialCost: 1300,
        weightKg: 0.15,
        timeTaken: "5 days",
        desc: "An ivory silk dupatta with fine zari brocade edges, handwoven using the traditional Banarasi technique.",
      },
      {
        noun: "Banarasi Silk Stole",
        color: "wine red",
        price: 4100,
        materialCost: 1500,
        weightKg: 0.18,
        timeTaken: "5 days",
        desc: "A wine red silk stole with a narrow zari border, handwoven on a Banarasi pit loom.",
      },
    ],
  },
  {
    key: "lakshmi-kanchipuram",
    displayName: "Lakshmi Venkataraman",
    shopName: "Kanchi Pattu Silks",
    region: "Tamil Nadu",
    pincode: "631502",
    language: "ta",
    category: "textiles",
    craftFolder: "handloom-textiles",
    material: "Silk",
    technique: "Kanchipuram handloom silk weaving with temple-border zari",
    careInstructions: "Dry clean only. Air out in shade before storing; avoid folding on the same crease repeatedly.",
    giTag: "Kancheepuram Silk",
    products: [
      {
        noun: "Kanchipuram Silk Saree",
        color: "temple green",
        price: 12000,
        materialCost: 4800,
        weightKg: 0.7,
        timeTaken: "10 days",
        desc: "A temple-green Kanchipuram silk saree with a contrasting gold zari temple border, handwoven on a traditional loom.",
      },
      {
        noun: "Kanchipuram Silk Saree",
        color: "magenta",
        price: 13500,
        materialCost: 5200,
        weightKg: 0.72,
        timeTaken: "12 days",
        desc: "A magenta Kanchipuram silk saree with a wide gold zari border, handwoven in Kanchipuram.",
      },
      {
        noun: "Kanchipuram Silk Stole",
        color: "mustard yellow",
        price: 4800,
        materialCost: 1800,
        weightKg: 0.2,
        timeTaken: "6 days",
        desc: "A mustard yellow silk stole with a narrow zari border, handwoven using the Kanchipuram technique.",
      },
    ],
  },
  {
    key: "nabanita-krishnanagar",
    displayName: "Nabanita Sarkar",
    shopName: "Krishnanagar Clay Studio",
    region: "West Bengal",
    pincode: "741101",
    language: "bn",
    category: "pottery",
    craftFolder: "pottery-terracotta",
    material: "Clay",
    technique: "Hand-modelled Krishnanagar clay figurine work",
    careInstructions: "Handle gently, this is a hand-modelled clay piece. Dust with a soft, dry cloth only.",
    giTag: null,
    products: [
      {
        noun: "Krishnanagar Clay Figurine, village woman with pot",
        color: null,
        price: 1400,
        materialCost: 500,
        weightKg: 0.4,
        timeTaken: "5 days",
        desc: "A hand-modelled and hand-painted Krishnanagar clay figurine of a village woman carrying a water pot.",
      },
      {
        noun: "Krishnanagar Clay Wall Plaque, bird motif",
        color: null,
        price: 900,
        materialCost: 350,
        weightKg: 0.5,
        timeTaken: "4 days",
        desc: "A hand-modelled clay wall plaque with a hand-painted bird motif, made in the Krishnanagar style.",
      },
      {
        noun: "Krishnanagar Clay Doll, traditional dancer",
        color: null,
        price: 1600,
        materialCost: 600,
        weightKg: 0.35,
        timeTaken: "6 days",
        desc: "A hand-modelled and hand-painted clay doll depicting a traditional dancer, in the Krishnanagar clay-work style.",
      },
    ],
  },
  {
    key: "gopal-bikaner",
    displayName: "Gopal Chitrakar",
    shopName: "Thar Terracotta",
    region: "Rajasthan",
    pincode: "334001",
    language: "hi",
    category: "pottery",
    craftFolder: "pottery-terracotta",
    material: "Terracotta",
    technique: "Hand-thrown and sun-dried Bikaner terracotta pottery",
    careInstructions: "Hand wash only. Not microwave or dishwasher safe.",
    giTag: null,
    products: [
      {
        noun: "Terracotta Surahi",
        color: "natural finish",
        price: 650,
        materialCost: 220,
        weightKg: 1.2,
        timeTaken: "3 days",
        desc: "A hand-thrown terracotta surahi with a natural clay finish, shaped and sun-dried in Bikaner.",
      },
      {
        noun: "Terracotta Planter",
        color: "medium size",
        price: 550,
        materialCost: 180,
        weightKg: 1.5,
        timeTaken: "3 days",
        desc: "A hand-thrown medium terracotta planter, left in its natural clay finish.",
      },
      {
        noun: "Terracotta Diya Set (6 pieces)",
        color: null,
        price: 350,
        materialCost: 110,
        weightKg: 0.6,
        timeTaken: "2 days",
        desc: "A set of six hand-shaped terracotta diyas, sun-dried and left unpainted.",
      },
    ],
  },
  {
    key: "bipul-kokrajhar",
    displayName: "Bipul Boro",
    shopName: "Kokrajhar Bamboo Crafts",
    region: "Assam",
    pincode: "783370",
    language: "as",
    category: "bamboo-cane",
    craftFolder: "bamboo-cane",
    material: "Bamboo",
    technique: "Hand-woven Assamese bamboo basketry",
    careInstructions: "Wipe with a dry cloth. Keep away from prolonged direct moisture.",
    giTag: null,
    products: [
      {
        noun: "Bamboo Utility Basket, medium",
        color: null,
        price: 650,
        materialCost: 220,
        weightKg: 0.4,
        timeTaken: "3 days",
        desc: "A medium hand-woven bamboo utility basket, made using traditional Assamese basketry technique.",
      },
      {
        noun: "Bamboo Serving Tray",
        color: null,
        price: 550,
        materialCost: 190,
        weightKg: 0.35,
        timeTaken: "3 days",
        desc: "A hand-woven bamboo serving tray with a flat woven base, made in Kokrajhar, Assam.",
      },
      {
        noun: "Bamboo Cylindrical Lampshade",
        color: null,
        price: 1200,
        materialCost: 450,
        weightKg: 0.5,
        timeTaken: "4 days",
        desc: "A hand-woven cylindrical bamboo lampshade, made using fine split-bamboo weaving.",
      },
    ],
  },
  {
    key: "lalthanpuii-aizawl",
    displayName: "Lalthanpuii Ralte",
    shopName: "Mizo Cane Works",
    region: "Mizoram",
    pincode: "796001",
    language: "en",
    category: "bamboo-cane",
    craftFolder: "bamboo-cane",
    material: "Cane",
    technique: "Traditional Mizo hand-woven cane craft",
    careInstructions: "Wipe with a dry cloth. Keep away from prolonged direct sunlight.",
    giTag: null,
    products: [
      {
        noun: "Cane Fruit Basket",
        color: null,
        price: 800,
        materialCost: 300,
        weightKg: 0.5,
        timeTaken: "4 days",
        desc: "A hand-woven cane fruit basket made using traditional Mizo weaving technique.",
      },
      {
        noun: "Cane Storage Box with Lid",
        color: null,
        price: 1400,
        materialCost: 550,
        weightKg: 0.8,
        timeTaken: "5 days",
        desc: "A hand-woven cane storage box with a fitted lid, made in Aizawl, Mizoram.",
      },
      {
        noun: "Cane Table Mat Set (4 pieces)",
        color: null,
        price: 600,
        materialCost: 220,
        weightKg: 0.3,
        timeTaken: "3 days",
        desc: "A set of four hand-woven cane table mats, made using traditional Mizo cane weaving.",
      },
    ],
  },
  {
    key: "iqbal-moradabad",
    displayName: "Iqbal Hussain",
    shopName: "Moradabad Brass House",
    region: "Uttar Pradesh",
    pincode: "244001",
    language: "ur",
    category: "other",
    craftFolder: "brassware-metalwork",
    material: "Brass",
    technique: "Hand-cast and hand-engraved Moradabad brassware",
    careInstructions: "Wipe with a dry cloth. Polish occasionally with a brass cleaner to maintain shine.",
    giTag: "Moradabad Metal Craft",
    products: [
      {
        noun: "Engraved Brass Vase, medium",
        color: null,
        price: 2200,
        materialCost: 850,
        weightKg: 0.9,
        timeTaken: "6 days",
        desc: "A hand-cast brass vase with a hand-engraved floral motif, made in Moradabad.",
      },
      {
        noun: "Brass Diya Set (5 pieces)",
        color: null,
        price: 950,
        materialCost: 380,
        weightKg: 0.5,
        timeTaken: "4 days",
        desc: "A set of five hand-cast brass diyas with a plain polished finish.",
      },
      {
        noun: "Engraved Brass Decorative Bowl",
        color: null,
        price: 1800,
        materialCost: 700,
        weightKg: 0.7,
        timeTaken: "5 days",
        desc: "A hand-engraved brass decorative bowl, hand-cast and finished in Moradabad.",
      },
    ],
  },
  {
    key: "shivraj-bidar",
    displayName: "Shivraj Nadaf",
    shopName: "Bidri Karkhana",
    region: "Karnataka",
    pincode: "585401",
    language: "kn",
    category: "other",
    craftFolder: "brassware-metalwork",
    material: "Other",
    technique: "Bidriware: blackened zinc-alloy metal inlaid with silver wire",
    careInstructions: "Wipe with a dry, soft cloth only. Avoid water and metal polish, which can damage the blackened finish.",
    giTag: "Bidriware",
    products: [
      {
        noun: "Bidri Jewellery Box",
        color: null,
        price: 4500,
        materialCost: 1800,
        weightKg: 0.4,
        timeTaken: "12 days",
        desc: "A blackened Bidri metal jewellery box inlaid with a silver wire floral pattern, handcrafted in Bidar.",
      },
      {
        noun: "Bidri Vase",
        color: null,
        price: 6200,
        materialCost: 2500,
        weightKg: 0.6,
        timeTaken: "15 days",
        desc: "A Bidri metal vase with hand-inlaid silver wire work on a blackened finish.",
      },
      {
        noun: "Bidri Decorative Plate",
        color: null,
        price: 3800,
        materialCost: 1500,
        weightKg: 0.35,
        timeTaken: "10 days",
        desc: "A hand-engraved Bidri decorative plate with silver wire inlay on a blackened alloy base.",
      },
    ],
  },
  {
    key: "kalu-bagru",
    displayName: "Kalu Ram Chhipa",
    shopName: "Bagru Hand Block",
    region: "Rajasthan",
    pincode: "303007",
    language: "hi",
    category: "textiles",
    craftFolder: "block-print",
    material: "Cotton",
    technique: "Bagru hand block printing with natural dyes",
    careInstructions: "Hand wash separately in cold water. First wash may release some natural dye.",
    giTag: null,
    products: [
      {
        noun: "Bagru Block Print Cotton Saree, indigo floral",
        color: null,
        price: 1800,
        materialCost: 650,
        weightKg: 0.45,
        timeTaken: "5 days",
        desc: "A cotton saree hand block printed with an indigo floral pattern using natural dyes, in the Bagru style.",
      },
      {
        noun: "Bagru Block Print Bedsheet Set with 2 Pillow Covers",
        color: null,
        price: 1600,
        materialCost: 600,
        weightKg: 0.7,
        timeTaken: "4 days",
        desc: "A double-bed cotton bedsheet set with two pillow covers, hand block printed with natural dyes.",
      },
      {
        noun: "Bagru Block Print Cushion Covers (set of 2)",
        color: null,
        price: 650,
        materialCost: 240,
        weightKg: 0.25,
        timeTaken: "3 days",
        desc: "A set of two cotton cushion covers, hand block printed in the Bagru style with natural dyes.",
      },
      {
        noun: "Bagru Block Print Cotton Fabric, per metre",
        color: null,
        price: 450,
        materialCost: 170,
        weightKg: 0.2,
        timeTaken: "2 days",
        desc: "Cotton fabric hand block printed with a floral motif using natural dyes, sold by the metre.",
      },
    ],
  },
  {
    key: "abdul-bhuj",
    displayName: "Abdul Rahim Khatri",
    shopName: "Kutch Ajrakh Studio",
    region: "Gujarat",
    pincode: "370001",
    language: "gu",
    category: "textiles",
    craftFolder: "block-print",
    material: "Cotton",
    technique: "Ajrakh hand block printing with natural indigo dye",
    careInstructions: "Hand wash separately in cold water. First wash may release some natural dye.",
    giTag: null,
    products: [
      {
        noun: "Ajrakh Block Print Cotton Stole, indigo and madder red",
        color: null,
        price: 1500,
        materialCost: 550,
        weightKg: 0.2,
        timeTaken: "6 days",
        desc: "A cotton stole hand block printed in the Ajrakh style with natural indigo and madder red dyes.",
      },
      {
        noun: "Ajrakh Block Print Dupatta",
        color: null,
        price: 2200,
        materialCost: 850,
        weightKg: 0.25,
        timeTaken: "7 days",
        desc: "A cotton dupatta hand block printed with a traditional Ajrakh geometric pattern using natural indigo dye.",
      },
      {
        noun: "Ajrakh Block Print Cotton Fabric, per metre",
        color: null,
        price: 650,
        materialCost: 250,
        weightKg: 0.22,
        timeTaken: "4 days",
        desc: "Cotton fabric hand block printed with a traditional Ajrakh geometric motif, sold by the metre.",
      },
    ],
  },
  {
    key: "kamala-cuttack",
    displayName: "Kamala Rani Behera",
    shopName: "Cuttack Tarakasi",
    region: "Odisha",
    pincode: "753001",
    language: "or",
    category: "jewelry",
    craftFolder: "jewellery",
    material: "Silver",
    technique: "Cuttack silver filigree (Tarakasi)",
    careInstructions: "Store in a dry pouch. Avoid contact with perfume or water; silver filigree wire is delicate.",
    giTag: "Silver Filigree of Cuttack",
    products: [
      {
        noun: "Silver Filigree Earrings, peacock motif",
        color: null,
        price: 2800,
        materialCost: 1100,
        weightKg: 0.03,
        timeTaken: "6 days",
        desc: "A pair of silver filigree earrings with a peacock motif, hand-crafted using the Cuttack Tarakasi technique.",
      },
      {
        noun: "Silver Filigree Pendant, floral design",
        color: null,
        price: 3200,
        materialCost: 1300,
        weightKg: 0.025,
        timeTaken: "7 days",
        desc: "A silver filigree pendant with a floral design, hand-crafted in Cuttack using fine silver wire work.",
      },
      {
        noun: "Silver Filigree Hair Pin",
        color: null,
        price: 1800,
        materialCost: 700,
        weightKg: 0.02,
        timeTaken: "5 days",
        desc: "A hand-crafted silver filigree hair pin, made using the traditional Cuttack Tarakasi technique.",
      },
    ],
  },
  {
    key: "sunita-jaipur",
    displayName: "Sunita Meena",
    shopName: "Rajwada Silver Jewels",
    region: "Rajasthan",
    pincode: "302001",
    language: "hi",
    category: "jewelry",
    craftFolder: "jewellery",
    material: "Silver",
    technique: "Hand-crafted oxidised Rajasthani silver jewellery",
    careInstructions: "Store in a dry pouch, away from moisture, to preserve the oxidised finish.",
    giTag: null,
    products: [
      {
        noun: "Oxidised Silver Necklace, tribal design",
        color: null,
        price: 3500,
        materialCost: 1400,
        weightKg: 0.08,
        timeTaken: "5 days",
        desc: "A hand-crafted oxidised silver necklace with a Rajasthani tribal design.",
      },
      {
        noun: "Oxidised Silver Jhumka Earrings",
        color: null,
        price: 1600,
        materialCost: 620,
        weightKg: 0.04,
        timeTaken: "4 days",
        desc: "A pair of hand-crafted oxidised silver jhumka earrings in the traditional Rajasthani style.",
      },
      {
        noun: "Oxidised Silver Anklets, pair",
        color: null,
        price: 2200,
        materialCost: 850,
        weightKg: 0.1,
        timeTaken: "5 days",
        desc: "A pair of hand-crafted oxidised silver anklets with bell detailing.",
      },
    ],
  },
  {
    key: "basheer-srinagar",
    displayName: "Basheer Ahmed",
    shopName: "Kashmir Walnut Wood Works",
    region: "Jammu and Kashmir",
    pincode: "190001",
    language: "ks",
    category: "woodwork",
    craftFolder: "wood-carving",
    material: "Wood",
    technique: "Hand-carved Kashmiri walnut wood carving",
    careInstructions: "Dust with a dry cloth. Avoid direct sunlight and excess moisture.",
    giTag: null,
    products: [
      {
        noun: "Walnut Wood Jewellery Box, chinar leaf motif",
        color: null,
        price: 5500,
        materialCost: 2200,
        weightKg: 1.2,
        timeTaken: "12 days",
        desc: "A hand-carved Kashmiri walnut wood jewellery box with a chinar leaf motif.",
      },
      {
        noun: "Walnut Wood Wall Panel",
        color: null,
        price: 8500,
        materialCost: 3400,
        weightKg: 2.5,
        timeTaken: "18 days",
        desc: "A hand-carved walnut wood wall panel, carved in the traditional Kashmiri style.",
      },
      {
        noun: "Walnut Wood Photo Frame",
        color: null,
        price: 2800,
        materialCost: 1100,
        weightKg: 0.6,
        timeTaken: "8 days",
        desc: "A hand-carved walnut wood photo frame with a floral border, made in Srinagar.",
      },
    ],
  },
  {
    key: "manjunath-channapatna",
    displayName: "Manjunath Gowda",
    shopName: "Channapatna Toy Craft",
    region: "Karnataka",
    pincode: "562160",
    language: "kn",
    category: "woodwork",
    craftFolder: "wood-carving",
    material: "Wood",
    technique: "Channapatna lacquered wood turning",
    careInstructions: "Wipe with a dry cloth. Keep away from water to preserve the lacquer finish.",
    giTag: "Channapatna Toys & Dolls",
    products: [
      {
        noun: "Channapatna Wooden Spinning Top Set (3 pieces)",
        color: null,
        price: 450,
        materialCost: 160,
        weightKg: 0.15,
        timeTaken: "3 days",
        desc: "A set of three lacquered wooden spinning tops, hand-turned and finished in Channapatna.",
      },
      {
        noun: "Channapatna Wooden Stacking Rings Toy",
        color: null,
        price: 650,
        materialCost: 240,
        weightKg: 0.3,
        timeTaken: "4 days",
        desc: "A lacquered wooden stacking rings toy, hand-turned and coloured with natural dyes.",
      },
      {
        noun: "Channapatna Lacquered Wooden Elephant Figurine",
        color: null,
        price: 550,
        materialCost: 200,
        weightKg: 0.25,
        timeTaken: "3 days",
        desc: "A lacquered wooden elephant figurine, hand-turned using the traditional Channapatna technique.",
      },
      {
        noun: "Channapatna Wooden Rattle",
        color: null,
        price: 350,
        materialCost: 130,
        weightKg: 0.1,
        timeTaken: "2 days",
        desc: "A lacquered wooden rattle with a baby-safe finish, hand-turned in Channapatna.",
      },
    ],
  },
];

const BUYERS = [
  {
    key: "ritu-delhi",
    displayName: "Ritu Malhotra",
    shopName: "Malhotra Home Decor",
    region: "Delhi",
    pincode: "110001",
    language: "en",
  },
  {
    key: "arjun-kochi",
    displayName: "Arjun Nair",
    shopName: "Nair & Sons Retail",
    region: "Kerala",
    pincode: "682001",
    language: "en",
  },
  {
    key: "priya-mumbai",
    displayName: "Priya Sharma",
    shopName: null,
    region: "Maharashtra",
    pincode: "400001",
    language: "en",
  },
  {
    key: "fatima-hyderabad",
    displayName: "Fatima Sheikh",
    shopName: "Sheikh Boutique",
    region: "Telangana",
    pincode: "500001",
    language: "en",
  },
  {
    key: "karan-chandigarh",
    displayName: "Karan Mehta",
    shopName: "Mehta Exports",
    region: "Punjab",
    pincode: "160001",
    language: "en",
  },
];

const INQUIRY_MESSAGES = [
  "Is this available in a larger size?",
  "Do you ship to Delhi, and what would the estimated delivery time be?",
  "Can I get this in a different colour?",
  "I'm interested in a bulk order of 20 pieces for my store, is a discount available?",
  "Is this fully handmade, or is any part machine made?",
  "What are the exact dimensions of this piece?",
  "Do you have this with a matching stole or dupatta?",
  "Can the motif be customised for a special order?",
  "Is cash on delivery available for this?",
  "I'd like to order 5 pieces as corporate gifts, can you help with that?",
  "How long will it take to make and ship this?",
  "Do you have this piece in stock right now, or is it made to order?",
  "Can you share a few more photos before I decide?",
];

const VIEW_REGIONS = [
  "Delhi",
  "Maharashtra",
  "Karnataka",
  "Tamil Nadu",
  "West Bengal",
  "Telangana",
  "Gujarat",
  "Punjab",
  "Kerala",
  "Uttar Pradesh",
];

function fakeMobileNumber(seed) {
  const prefix = ["6", "7", "8", "9"][seed % 4];
  let digits = prefix;
  let n = seed * 9301 + 49297;
  for (let i = 0; i < 9; i += 1) {
    n = (n * 9301 + 49297) % 233280;
    digits += Math.floor((n / 233280) * 10);
  }
  return `+91 ${digits.slice(0, 5)} ${digits.slice(5, 10)}`;
}

async function wipeSeedData() {
  const { data: seedUsers, error: findError } = await supabase.from("users").select("id").eq("is_seed", true);
  if (findError) throw new Error(`Could not look up existing seed data: ${findError.message}`);

  if (!seedUsers || seedUsers.length === 0) {
    console.log("No existing seed data found.");
    return;
  }

  const { error: deleteError } = await supabase
    .from("users")
    .delete()
    .in(
      "id",
      seedUsers.map((row) => row.id),
    );
  if (deleteError) throw new Error(`Could not wipe existing seed data: ${deleteError.message}`);

  console.log(
    `Wiped ${seedUsers.length} seed user(s) and everything that cascades from them (products, inquiries, product views).`,
  );
}

async function insertInBatches(table, rows, batchSize = 200) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from(table).insert(batch);
    if (error) throw new Error(`Could not insert into ${table}: ${error.message}`);
  }
}

function generateViewRows(productId) {
  const rows = [];
  const DAYS = 28;
  const popularity = 0.3 + Math.random() * 1.7;
  for (let dayOffset = 0; dayOffset < DAYS; dayOffset += 1) {
    if (Math.random() >= 0.35 * popularity) continue;
    const count = 1 + Math.floor(Math.random() * 3 * popularity);
    for (let i = 0; i < count; i += 1) {
      const hoursIntoDay = Math.random() * 24;
      const ms = Date.now() - (dayOffset * 24 + hoursIntoDay) * 60 * 60 * 1000;
      rows.push({
        product_id: productId,
        viewer_role: "buyer",
        region: VIEW_REGIONS[Math.floor(Math.random() * VIEW_REGIONS.length)],
        created_at: new Date(ms).toISOString(),
      });
    }
  }
  return rows;
}

async function main() {
  console.log("Step 1: wiping any existing seed data...");
  await wipeSeedData();

  if (WIPE_ONLY) {
    console.log("\nDone. Seed data wiped, nothing regenerated (--wipe).");
    return;
  }

  console.log("\nStep 2: collecting seed product photos...");
  const imagesByFolder = await loadCraftImages();

  console.log("\nStep 3: creating artisans and products...");
  const year = new Date().getFullYear();
  const publishedProductIds = [];
  let globalProductIndex = 0;
  let pendingCount = 0;
  let approvedCount = 0;

  for (const artisan of ARTISANS) {
    const { data: userRow, error: userError } = await supabase
      .from("users")
      .insert({
        email: `${artisan.key}@kalasetu-seed.demo`,
        display_name: artisan.displayName,
        shop_name: artisan.shopName,
        region: artisan.region,
        pincode: artisan.pincode,
        language: artisan.language,
        role: "artisan",
        is_active: true,
        total_products: artisan.products.length,
        is_seed: true,
      })
      .select("id")
      .single();
    if (userError) throw new Error(`Could not create artisan ${artisan.displayName}: ${userError.message}`);

    let productIndexInFolder = 0;
    for (const product of artisan.products) {
      const passportId = await generatePassportId(year);
      const imageUrl = pickImage(imagesByFolder, artisan.craftFolder, productIndexInFolder, CRAFT_FOLDERS[artisan.craftFolder]);
      const isPending = globalProductIndex % 5 === 4;
      const title = product.color ? `${product.noun}, ${product.color}` : product.noun;

      const { data: productRow, error: productError } = await supabase
        .from("products")
        .insert({
          user_id: userRow.id,
          category: artisan.category,
          material: artisan.material,
          region: artisan.region,
          artisan_name: artisan.shopName || artisan.displayName,
          title_en: title,
          title_local: title,
          description_en: product.desc,
          description_local: product.desc,
          local_language: artisan.language,
          image_url: imageUrl,
          price: product.price,
          material_cost: product.materialCost,
          status: "published",
          flagged: false,
          auto_flag_reason: product.autoFlagReason ?? null,
          review_status: isPending ? "pending" : "approved",
          reviewed_at: isPending ? null : pastTimestamp(1, 25),
          reviewed_by: null,
          review_reason: null,
          passport_id: passportId,
          technique: artisan.technique,
          time_taken: product.timeTaken,
          gi_tag: artisan.giTag,
          care_instructions: artisan.careInstructions,
          weight_kg: product.weightKg,
          is_seed: true,
          created_at: pastTimestamp(3, 45),
          updated_at: pastTimestamp(1, 3),
        })
        .select("id")
        .single();
      if (productError) throw new Error(`Could not create product "${title}": ${productError.message}`);

      publishedProductIds.push(productRow.id);
      if (isPending) pendingCount += 1;
      else approvedCount += 1;
      productIndexInFolder += 1;
      globalProductIndex += 1;
    }
  }
  console.log(
    `  Created ${globalProductIndex} products across ${ARTISANS.length} artisans (${approvedCount} already reviewed, ${pendingCount} awaiting moderation).`,
  );

  console.log("\nStep 4: creating buyer accounts...");
  const buyerIds = [];
  for (const buyer of BUYERS) {
    const { data: buyerRow, error: buyerError } = await supabase
      .from("users")
      .insert({
        email: `${buyer.key}@kalasetu-seed.demo`,
        display_name: buyer.displayName,
        shop_name: buyer.shopName,
        region: buyer.region,
        pincode: buyer.pincode,
        language: buyer.language,
        role: "buyer",
        is_active: true,
        is_seed: true,
      })
      .select("id")
      .single();
    if (buyerError) throw new Error(`Could not create buyer ${buyer.displayName}: ${buyerError.message}`);
    buyerIds.push(buyerRow.id);
  }
  console.log(`  Created ${buyerIds.length} buyer accounts.`);

  console.log("\nStep 5: creating inquiries...");
  const artisanIdByProductId = new Map();
  {
    const { data: productOwners, error: ownerError } = await supabase
      .from("products")
      .select("id, user_id")
      .in("id", publishedProductIds);
    if (ownerError) throw new Error(`Could not look up product owners: ${ownerError.message}`);
    for (const row of productOwners) artisanIdByProductId.set(row.id, row.user_id);
  }

  const inquiryRows = [];
  const contactPreferences = ["email", "phone", "whatsapp"];
  for (let i = 0; i < 13; i += 1) {
    const buyerId = buyerIds[i % buyerIds.length];
    const productId = publishedProductIds[Math.floor(Math.random() * publishedProductIds.length)];
    const artisanId = artisanIdByProductId.get(productId);
    const preference = contactPreferences[i % contactPreferences.length];
    const createdAt = pastTimestamp(0.2, 10);
    const isRead = i % 3 !== 0;
    const isResponded = i % 4 === 0;
    inquiryRows.push({
      product_id: productId,
      buyer_id: buyerId,
      artisan_id: artisanId,
      message: INQUIRY_MESSAGES[i % INQUIRY_MESSAGES.length],
      quantity: i % 3 === 0 ? 1 + (i % 5) : null,
      contact_preference: preference,
      contact_value: preference === "email" ? null : fakeMobileNumber(i + 1),
      status: i % 6 === 5 ? "closed" : "open",
      read_at: isRead ? pastTimestamp(0, 9) : null,
      responded_at: isResponded ? pastTimestamp(0, 8) : null,
      notified_at: null,
      created_at: createdAt,
    });
  }
  await insertInBatches("inquiries", inquiryRows);
  console.log(`  Created ${inquiryRows.length} inquiries.`);

  console.log("\nStep 6: backfilling historical view data (last 28 days)...");
  let allViewRows = [];
  for (const productId of publishedProductIds) {
    allViewRows = allViewRows.concat(generateViewRows(productId));
  }
  await insertInBatches("product_views", allViewRows);
  console.log(`  Created ${allViewRows.length} view records across ${publishedProductIds.length} products.`);

  console.log("\nDone. The marketplace, admin console, and analytics dashboard now have realistic seed data.");
  console.log("Every seeded row is flagged is_seed = true. Run with --wipe to remove it all cleanly.");
}

main().catch((err) => {
  console.error("\nSeed script failed:", err.message);
  process.exit(1);
});
