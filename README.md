# Distributed Property Listing Backend

This project is a highly available, distributed property listing backend simulating two geographic regions (US and EU). It demonstrates how to distribute traffic geographically, handles asynchronous data replication using Apache Kafka, and utilizes optimistic locking to manage data consistency during concurrent updates.

The entire system is containerized with Docker and requires a robust cluster initialized with NGINX, Zookeeper, Kafka, PostgreSQL databases, and Node.js backends.

---

## 🏗 System Architecture

The project employs a multi-container architecture composed of the following services:

### Services:

- **`nginx`**: A reverse proxy facilitating global routing and active-passive failover between the two regions.
- **`kafka` & `zookeeper`**: Apache Kafka configured with Zookeeper for event stream processing to handle asynchronous data replication.
- **`db-us` & `db-eu`**: Independent PostgreSQL databases dedicated to the US and EU backends. Each seeds >1000 properties on startup.
- **`backend-us` & `backend-eu`**: Node.js/Express service instances running the backend logic for interacting with databases and Kafka.

---

## 📋 Core Features Implemented

1. **Docker Compose Orchestration** 🐳
   - Complete `docker-compose.yml` configures all microservices. Includes extensive health checks utilizing native tools (`pg_isready`, `wget`, `nc`) ensuring the services only boot when dependencies activate.

2. **Automated Data Initialization** 🎲
   - Both Postgres instances automatically seed datasets on boot via `$PGDATA` entrypoint initialization scripts. `properties` and `idempotency_keys` tables are scaffolded automatically.

3. **Global Sub-Routing & Active-Passive Failover** 🌐
   - Requests prefixed with `/us/*` naturally route to the `backend-us` and requests prefixed with `/eu/*` route to the `backend-eu`.
   - Uses NGINX's robust `backup` upstream directive. If the target upstream backend crashes, NGINX transparently fails over to route the traffic into the other backend container.

4. **Optimistic Locking for Concurrent Processing** 🔒
   - Uses a strict `version` incrementation protocol on update endpoints. When submitting an update, the request's version must match the stored version, otherwise it yields `HTTP 409 Conflict`.

5. **Idempotency Standards** 🔁
   - Endpoints require an `X-Request-ID` header. Utilizing PostgreSQL's unique constraints, duplicate cross-fire request UUIDs reject with `HTTP 422 Unprocessable Entity` avoiding duplicate writes.

6. **Event-Driven Asynchronous Data Replication** 📨
   - The primary region of an update natively produces the completed property object to a distinct Kafka topic named `property-updates`. Background workers instantiated in all application servers listen for transactions occurring from foreign regions to execute `UPSERT` queries natively mimicking the transactions.

---

## 🚀 Getting Started

Ensure you have Docker and Docker Compose installed locally.

### 1. Boot the Application

To run the cluster and orchestrate the environment natively:

```bash
docker compose up -d --build
```

> _Note: Initializing Zookeeper and Kafka might take 30-45 seconds. Keep an eye on health statuses:_ `docker ps`.

### 2. Available Endpoints

The NGINX orchestrator listens on `http://localhost:8080`. Modify the prefix `/us/` or `/eu/` identically.

- **`GET /:region/health`**: Simple availability health check.
- **`GET /:region/replication-lag`**: Examines Kafka consumer drift showing replication lag time in seconds.
- **`PUT /:region/properties/:id`**: Updates property. Required body params: `price` and `version`. Requires an custom `X-Request-ID` header.

Example usage:

```bash
curl -X PUT http://localhost:8080/us/properties/1 \
  -H "Content-Type: application/json" \
  -H "X-Request-ID: $(uuidgen)" \
  -d '{"price": 550000, "version": 1}'
```

---

## 🧪 Testing

The system is equipped with automated validation scripts inside the `tests/` directory ensuring correct behavior. Ensure your Docker cluster is running before executing these.

### 1. Test Concurrent Execution (Optimistic Locking)

Simulates a race condition scenario where two simultaneous requests attempt to update the same property with the same version natively. You will receive an `HTTP 200` and `HTTP 409` correctly identifying concurrency.

**Execution:**

```bash
node tests/concurrent_test.js
```

### 2. Test Region Isolation & NGINX Failover (Failover & Analytics)

Deconstructs the primary backend (`backend-us`) container forcing the NGINX router to failover requests dynamically to the surviving region (`backend-eu`). It evaluates logs and assures the fallback handled requests effectively.

**Execution:**

```bash
bash tests/demonstrate_failover.sh
```
