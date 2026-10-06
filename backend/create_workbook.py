"""Create Fitness_Tracker.xlsx with its first month (October 2026).

Run from the project root:  python -m backend.create_workbook
"""

from backend.workbook import create_workbook

if __name__ == "__main__":
    print(f"Created {create_workbook()}")
