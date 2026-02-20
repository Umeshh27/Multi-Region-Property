const crypto = require('crypto');

async function runTest() {
    console.log("Starting concurrent update test...");

    const propertyId = 1;
    const baseVersion = 1;

    const p1 = fetch(`http://localhost:8080/us/properties/${propertyId}`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'X-Request-ID': crypto.randomUUID()
        },
        body: JSON.stringify({ price: 200000, version: baseVersion })
    });

    const p2 = fetch(`http://localhost:8080/us/properties/${propertyId}`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'X-Request-ID': crypto.randomUUID()
        },
        body: JSON.stringify({ price: 300000, version: baseVersion })
    });

    const [res1, res2] = await Promise.all([p1, p2]);

    console.log(`Request 1 Status: ${res1.status}`);
    console.log(`Request 2 Status: ${res2.status}`);

    const statuses = [res1.status, res2.status];
    const successes = statuses.filter(s => s === 200).length;
    const conflicts = statuses.filter(s => s === 409).length;

    if (successes === 1 && conflicts === 1) {
        console.log("SUCCESS: Optimistic locking correctly prevented concurrent updates.");
        process.exit(0);
    } else {
        console.error(`FAILURE: Unexpected statuses. Expected one 200 and one 409. Got ${res1.status}, ${res2.status}`);
        process.exit(1);
    }
}

runTest();
