from flask import Flask, Blueprint, render_template

app = Flask(__name__)

# Blueprint
api = Blueprint("api", __name__, url_prefix="/api")

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/login", methods=["GET", "POST"])
def login():
    return "Login page"

@api.route("/users")
def list_users():
    return {"users": []}

@api.route("/users/<int:user_id>")
def get_user(user_id):
    return {"user_id": user_id}

app.register_blueprint(api)

if __name__ == "__main__":
    app.run(debug=True)
