const express = require('express');
const { Pool } = require('pg');
const { Kafka } = require('kafkajs');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
});

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

const kafka = new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID,
    brokers: [process.env.KAFKA_BROKERS || 'kafka:29092'],
    retry: {
        initialRetryTime: 100,
        retries: 10
    }
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: `property-group-${process.env.REGION}` });

let lastProcessedMessageTime = null;

app.get('/:region/health', (req, res) => {
    res.status(200).send('OK');
});

app.get('/:region/replication-lag', (req, res) => {
    if (!lastProcessedMessageTime) {
        return res.json({ lag_seconds: 0 });
    }
    const lagSeconds = (Date.now() - new Date(lastProcessedMessageTime).getTime()) / 1000;
    res.json({ lag_seconds: Math.max(0, parseFloat(lagSeconds.toFixed(2))) });
});

app.put('/:region/properties/:id', async (req, res) => {
    const { id } = req.params;
    const { price, version } = req.body;
    const requestId = req.headers['x-request-id'];

    if (!requestId) {
        return res.status(400).json({ error: 'Missing X-Request-ID header' });
    }

    if (version === undefined || price === undefined) {
        return res.status(400).json({ error: 'Missing price or version in body' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        try {
            await client.query('INSERT INTO idempotency_keys (key) VALUES ($1)', [requestId]);
        } catch (err) {
            if (err.code === '23505') {
                await client.query('ROLLBACK');
                return res.status(422).json({ error: 'Duplicate request', details: 'A request with this X-Request-ID has already been processed.' });
            }
            throw err;
        }

        const currentPropResult = await client.query('SELECT version FROM properties WHERE id = $1 FOR UPDATE', [id]);
        if (currentPropResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Property not found' });
        }

        const currentVersion = currentPropResult.rows[0].version;
        if (currentVersion !== version) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Conflict: version mismatch. The record has been modified by another transaction.', currentVersion });
        }

        const newVersion = version + 1;
        const now = new Date();
        const updateResult = await client.query(
            `UPDATE properties SET price = $1, version = $2, updated_at = $3 WHERE id = $4 AND version = $5 RETURNING *`,
            [price, newVersion, now, id, version]
        );

        if (updateResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Conflict: version mismatch during concurrency' });
        }

        const updatedProperty = updateResult.rows[0];

        try {
            await producer.send({
                topic: 'property-updates',
                messages: [
                    { value: JSON.stringify(updatedProperty) }
                ],
            });
        } catch (kafkaErr) {
            console.error('Kafka produce error:', kafkaErr);
            throw kafkaErr; 
        }

        await client.query('COMMIT');

        return res.json({
            id: Number(updatedProperty.id),
            price: Number(updatedProperty.price),
            version: updatedProperty.version,
            updated_at: updatedProperty.updated_at
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error during PUT property:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    } finally {
        client.release();
    }
});

const startKafkaConsumer = async () => {
    try {
        await consumer.connect();
        await consumer.subscribe({ topic: 'property-updates', fromBeginning: true });

        await consumer.run({
            eachMessage: async ({ topic, partition, message }) => {
                const payload = JSON.parse(message.value.toString());
                const messageTime = new Date(payload.updated_at);
                lastProcessedMessageTime = messageTime;

                if (payload.region_origin === process.env.REGION) {
                    return;
                }

                const { id, price, bedrooms, bathrooms, region_origin, version, updated_at } = payload;
                
                try {
                    await pool.query(
                        `INSERT INTO properties (id, price, bedrooms, bathrooms, region_origin, version, updated_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)
                         ON CONFLICT (id) 
                         DO UPDATE SET 
                             price = EXCLUDED.price, 
                             bedrooms = EXCLUDED.bedrooms, 
                             bathrooms = EXCLUDED.bathrooms,
                             region_origin = EXCLUDED.region_origin,
                             version = EXCLUDED.version, 
                             updated_at = EXCLUDED.updated_at
                         WHERE properties.version < EXCLUDED.version`,
                        [id, price, bedrooms, bathrooms, region_origin, version, updated_at]
                    );
                    console.log(`Replicated update for property ${id} from region ${region_origin} successfully.`);
                } catch (dbErr) {
                    console.error('Error updating foreign property via Kafka:', dbErr);
                }
            },
        });
    } catch (err) {
        console.error('Error starting Kafka consumer:', err);
        setTimeout(startKafkaConsumer, 5000);
    }
};

const startServer = async () => {
    try {
        await producer.connect();
        console.log('Kafka producer connected');
        
        startKafkaConsumer();

        const port = process.env.PORT || 3000;
        app.listen(port, () => {
            console.log(`Region ${process.env.REGION} backend listening on port ${port}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
};

startServer();
