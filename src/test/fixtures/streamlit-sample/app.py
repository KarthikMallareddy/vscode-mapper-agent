import streamlit as st

st.set_page_config(page_title="Sample Streamlit App", layout="wide")

# Session state
if "count" not in st.session_state:
    st.session_state.count = 0

def increment():
    st.session_state.count += 1

def reset():
    st.session_state.count = 0

st.title("Counter App")
st.write(f"Count: {st.session_state.count}")

col1, col2 = st.columns(2)
with col1:
    st.button("Increment", on_click=increment)
with col2:
    st.button("Reset", on_click=reset)

# Navigation
st.page_link("pages/settings.py", label="Go to Settings")
