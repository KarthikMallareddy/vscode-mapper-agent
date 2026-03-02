import streamlit as st

st.title("Settings Page")
name = st.text_input("Your name", on_change=lambda: None)
st.session_state.user_name = name
