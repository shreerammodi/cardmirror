FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .

# Single worker ONLY: the SSE push registry is in-process.
# --limit-concurrency is a connection-storm backstop; it counts
# long-lived SSE streams too, so keep it far above the expected
# concurrent-stream population.
# --timeout-graceful-shutdown is REQUIRED: without it, a stopped
# instance waits forever for its open SSE streams, lingering unbound as
# a zombie that keeps heartbeating clients while the replacement serves
# the port — those clients' pushes silently go nowhere.
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8000} --limit-concurrency 4096 --timeout-graceful-shutdown 5"]
