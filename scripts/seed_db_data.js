/**
 * seed_avirat_data.js
 *
 * Seeds dummy data into database "avirat"
 * Postgres on localhost (Docker Desktop)
 */

import pkg from "pg";
const { Client } = pkg;

const client = new Client({
  host: "localhost",
  port: 5432,
  user: "postgres",
  password: "postgres",
  database: "avirat",
});

function yymmdd(date = new Date()) {
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return Number(`${yy}${mm}${dd}`);
}

async function seed() {
  await client.connect();
  console.log("Connected to DB");

  try {
    await client.query("BEGIN");

    /* -------- CLEAN EXISTING DATA (SAFE ORDER) -------- */
    await client.query(`
      TRUNCATE order_items, orders, products, subcategories, categories, users
      RESTART IDENTITY CASCADE;
    `);

    /* -------- USERS (10) -------- */
    const users = [];
    for (let i = 1; i <= 10; i++) {
      const res = await client.query(
        `
        INSERT INTO users (username, email, phone_number)
        VALUES ($1, $2, $3)
        RETURNING id
        `,
        [`user_${i}`, `user${i}@test.com`, `99900000${i}`]
      );
      users.push(res.rows[0].id);
    }

    /* -------- CATEGORIES & SUBCATEGORIES -------- */
    const categories = {};
    const categoryData = {
      Electronics: ["Mobiles", "Laptops"],
      Grocery: ["Fruits", "Vegetables"],
      Fashion: ["Men", "Women"],
    };

    for (const [cat, subs] of Object.entries(categoryData)) {
      const catRes = await client.query(
        `INSERT INTO categories (name) VALUES ($1) RETURNING id`,
        [cat]
      );
      categories[cat] = { id: catRes.rows[0].id, subs: {} };

      for (const sub of subs) {
        const subRes = await client.query(
          `
          INSERT INTO subcategories (name, category_id)
          VALUES ($1, $2)
          RETURNING id
          `,
          [sub, catRes.rows[0].id]
        );
        categories[cat].subs[sub] = subRes.rows[0].id;
      }
    }

    /* -------- PRODUCTS -------- */
    const products = [];
    for (const cat of Object.values(categories)) {
      for (const subId of Object.values(cat.subs)) {
        for (let i = 1; i <= 5; i++) {
          const res = await client.query(
            `
            INSERT INTO products
              (product_name, weight_grams, category_id, subcategory_id, price)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, price, subcategory_id
            `,
            [
              `Product_${subId}_${i}`,
              100 + i * 50,
              cat.id,
              subId,
              50 + i * 20,
            ]
          );
          products.push(res.rows[0]);
        }
      }
    }

    /* -------- ORDERS + ORDER_ITEMS (~100 items) -------- */
    const today = yymmdd();
    let totalItemsInserted = 0;

    for (let i = 0; i < 25; i++) {
      const consumerId = users[i % users.length];

      const orderRes = await client.query(
        `
        INSERT INTO orders
          (consumer_id, order_date_yymmdd, order_amount, items_count)
        VALUES ($1, $2, 0, 0)
        RETURNING id
        `,
        [consumerId, today]
      );

      const orderId = orderRes.rows[0].id;
      let orderTotal = 0;
      let itemsCount = 0;

      const itemsInOrder = 3 + Math.floor(Math.random() * 3); // 3–5 items

      for (let j = 0; j < itemsInOrder; j++) {
        const product = products[Math.floor(Math.random() * products.length)];
        const qty = 1 + Math.floor(Math.random() * 3);
        const lineTotal = Number(product.price) * qty;

        await client.query(
          `
          INSERT INTO order_items
            (order_id, product_id, subcategory_id, order_date_yymmdd, price, quantity)
          VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            orderId,
            product.id,
            product.subcategory_id,
            today,
            product.price,
            qty,
          ]
        );

        orderTotal += lineTotal;
        itemsCount += qty;
        totalItemsInserted++;
      }

      await client.query(
        `
        UPDATE orders
        SET order_amount = $1, items_count = $2
        WHERE id = $3
        `,
        [orderTotal, itemsCount, orderId]
      );
    }

    await client.query("COMMIT");

    console.log("Seed completed successfully ✅");
    console.log("Users: 10");
    console.log("Order items inserted:", totalItemsInserted);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Seeding failed ❌", err);
  } finally {
    await client.end();
  }
}

seed();
