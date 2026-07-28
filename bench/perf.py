import time, statistics, tracemalloc, sys
try:
    from redteam.cases import load_cases
    from redteam import runner
    from redteam.store import ExploitStore
except Exception as e:
    print("IMPORT_FAIL:", e); sys.exit(2)

base = load_cases()
# replicate to 100 cases (round-robin)
cases100 = [base[i % len(base)] for i in range(100)]
target = runner._build_target("hermetic", None, None)

def one_run():
    store = ExploitStore()
    percase = []
    t0 = time.perf_counter()
    for c in cases100:
        s = time.perf_counter()
        runner.run_suite(target, [c], store=store, n_trials=1)
        percase.append((time.perf_counter()-s)*1000)
    total = time.perf_counter()-t0
    return total, percase

# warm
one_run()
tracemalloc.start()
totals, allpc = [], []
for _ in range(3):
    t, pc = one_run(); totals.append(t); allpc += pc
cur, peak = tracemalloc.get_traced_memory(); tracemalloc.stop()

allpc.sort()
p50 = statistics.median(allpc)
p95 = allpc[int(len(allpc)*0.95)]
med_total = statistics.median(totals)
print(f"n_cases=100 base_cases={len(base)}")
print(f"wall_clock_median_s={med_total:.3f}")
print(f"throughput_cases_per_s={100/med_total:.1f}")
print(f"per_case_p50_ms={p50:.2f}")
print(f"per_case_p95_ms={p95:.2f}")
print(f"peak_python_heap_mb={peak/1e6:.1f}")
print(f"runs_s={[round(t,3) for t in totals]}")
